<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * The room's oracle thread.
   *
   * Nothing here holds an answer: the server publishes both the question and
   * the streaming reply into the session document, and this panel is a reader
   * of that array like every other browser in the seminar. Which is the point —
   * a question asked in a private tab helps one student and teaches the teacher
   * nothing, so every question is attributed and lands on all screens at once.
   */
  import type * as Y from 'yjs'
  import { untrack } from 'svelte'
  import { getChat, readChatEntry, rereadRows, type ChatSnapshot } from '@shared/notebook'
  import { outgoingRow, settleOutbox, type Outgoing } from '@/lib/ask-outbox'
  import type {
    AiAction,
    AiAskRequest,
    AwarenessUser,
    ParticipantRole,
  } from '@shared/protocol'
  import { oracleModeIn, readRules } from '@shared/rules'
  import { kindOf } from '@shared/paths'
  import type { OracleMode } from '@shared/admin'
  import { api, ApiError } from '@/lib/api'
  import { oracleDraft } from '@/lib/drafts.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { permitsIn } from '@/lib/may'
  import { plural } from '@/lib/plural'
  import { watchBooks, watchCellNumbers } from '@/lib/yreactive.svelte'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import ChatTurn from './ChatTurn.svelte'

  const session = getSessionState()
  const cellNumbers = watchCellNumbers(session.doc)
  const chat = getChat(session.doc)
  const isHost = $derived(session.me.role === 'host')

  // Raw: the whole array is rebuilt on every observer fire, so deep-proxying
  // each snapshot would be work spent on objects that are replaced next frame.
  let entries = $state.raw<ChatSnapshot[]>(chat.map(readChatEntry))
  let status = $state<{ enabled: boolean; model: string; mode: OracleMode } | null>(null)
  /*
   * Вопрос переживает закрытие панели.
   *
   * Панель размонтируется вместе со своей кнопкой, а спрашивают обычно про
   * ячейку, на которую в этот момент и хочется посмотреть: свернул, глянул,
   * развернул — вопроса нет. Черновик живёт во вкладке, а не в компоненте.
   */
  const composing = oracleDraft
  let sendErrorRender = $state<() => string | null>(() => null)
  const sendError = $derived(sendErrorRender())
  /*
   * Слоу-мод — не авария, и красная плашка ему не идёт.
   *
   * «Не частите» стоит рядом с «оракул выключен для семинара»: это правило
   * инстанса, а не поломка, и человек с ним ничего не делает — он ждёт.
   * Поэтому спокойная строка того же вида, что и остальные правила ниже.
   */
  let slowNoticeRender = $state<() => string | null>(() => null)
  const slowNotice = $derived(slowNoticeRender())
  /** Момент, до которого сервер просил подождать, или 0. Мс, как Date.now. */
  let waitUntil = $state(0)
  /** Секунды на кнопке. Показ, не право: судья — сервер, см. `ask`. */
  let waitLeft = $state(0)
  let armed = $state(false)
  let pinned = $state(true)

  let scroller = $state<HTMLDivElement | null>(null)
  /** Содержимое треда: за его ростом следит наблюдатель размера, см. ниже. */
  let thread = $state<HTMLDivElement | null>(null)
  let composer = $state<HTMLTextAreaElement | null>(null)
  /**
   * Where the thread was when the reader stopped following it.
   *
   * Needed to tell "you scrolled up" from "you scrolled up and then something
   * arrived": a button that says there is a new answer when there is not is a
   * button people stop believing, and one that stays silent when there is loses
   * the answer entirely. Null while the thread is being followed.
   */
  let mark = $state<{ id: string; length: number } | null>(null)

  let composeTimer: number | undefined
  let armTimer: number | undefined
  /** What the room currently believes about us, so we only announce changes. */
  let composingSent = false

  /*
   * Hints mode is a real state of the room, not an error to discover by
   * pressing a button. The chips it refuses are not drawn at all — the rule
   * comes from actionAllowedIn, the same function the route refuses with, so
   * the two cannot drift.
   */
  /*
   * The instance's answer, narrowed by this room's own rule.
   *
   * /api/ai/status knows nothing about a seminar, so on its own it said "full"
   * for a room the server runs in hints — and the panel drew Explain, Fix and
   * Debug, each of which came back 403 when pressed. oracleModeIn is the same
   * function the route enforces with, so the two cannot drift.
   */
  const mode = $derived<OracleMode>(
    oracleModeIn(readRules(session.session.rules), status?.mode ?? 'full'),
  )
  const hintsOnly = $derived(mode === 'hints')
  /*
   * Спрашивать негде — по любой из двух причин.
   *
   * Optimistic until proven otherwise: a null status means "still checking",
   * and a dead input while a fetch is in flight reads as a broken oracle.
   *
   * Режим комнаты входит сюда наравне с инстансом. Правило «оракул выключен»
   * ставят на контрольную, и живое поле, отвечающее на каждый вопрос красной
   * строкой 403, читается классом как поломка, а не как решение
   * преподавателя. Правило комнаты известно этой вкладке сразу, ждать статуса
   * ему незачем.
   */
  const offline = $derived(mode === 'off' || (status !== null && !status.enabled))

  /**
   * Вопросы, отправленные и ещё не вернувшиеся из документа, — см. lib/ask-outbox.
   *
   * Не «показать и забыть»: откажет сервер — слоу-мод, потолок, оборванная
   * связь — строка снимается вместе с обещанием, а текст возвращается в поле.
   */
  let outbox = $state.raw<Outgoing[]>([])
  let outgoing = 0

  /** Поставить вопрос в ленту до ответа сервера. Возвращает имя строки. */
  function openOutbox(body: AiAskRequest): string {
    const id = `outgoing:${++outgoing}`
    outbox = [
      ...outbox,
      {
        row: outgoingRow({
          id,
          me: session.me,
          question: body.message,
          action: body.action ?? null,
          cellId: body.cellId ?? null,
          cellIds: body.cellIds ?? [],
          mode: body.mode,
          at: Date.now(),
        }),
        before: new Set(entries.map((entry) => entry.id)),
      },
    ]
    return id
  }

  /** Снять строку: её заменила настоящая запись — или отказ. */
  function closeOutbox(id: string): void {
    outbox = outbox.filter((row) => row.row.id !== id)
  }

  function settlePending(fresh: readonly ChatSnapshot[]): void {
    const pending = untrack(() => outbox)
    const left = settleOutbox(pending, fresh)
    if (left === pending) return
    const landed = landedIds(pending, left, fresh)
    if (landed.length > 0) {
      const alive = new Set(fresh.map((entry) => entry.id))
      const kept = [...untrack(() => inherited)].filter((id) => alive.has(id))
      inherited = new Set([...kept, ...landed])
    }
    outbox = left
  }

  $effect(() => {
    /*
     * Читает документ и пишет `entries` — и НИЧЕГО не читает из состояния.
     *
     * Стоило прочитать здесь `entries` или `outbox` (а подстановка исходящих
     * читала оба), как эффект стал зависеть от того, что сам же переписывает:
     * `chat.map` отдаёт новый массив на каждый проход, Svelte видит новое
     * значение, гоняет эффект заново — и комната встречала не тетрадь, а
     * `effect_update_depth_exceeded`. Свежий список идёт дальше переменной, а
     * прежний снимок и очередь исходящих берутся `untrack`.
     *
     * Перечитывается ТОЛЬКО задетое кадром (`rereadRows`): ответ дописывается
     * в Y.Text внутри одной записи, а прежний код на каждый кусочек собирал
     * весь тред заново — `toString()` каждого ответа и каждого рассуждения, то
     * есть работу по длине всего треда на каждый токен. Неизменившиеся снимки
     * остаются ТЕМИ ЖЕ объектами, поэтому производные каждого хода (дифф
     * патча, разбор markdown, роль автора) не пересчитываются.
     */
    const read = (events: Y.YEvent<any>[] | null) => {
      const previous = untrack(() => entries)
      const fresh = rereadRows(previous, chat, readChatEntry, events)
      if (fresh !== previous) entries = fresh
      settlePending(fresh)
    }
    read(null)
    // Deep: an answer streams into a Y.Text *inside* an entry. The array itself
    // only changes when somebody asks something new.
    const onFrame = (events: Y.YEvent<any>[]) => read(events)
    chat.observeDeep(onFrame)
    return () => chat.unobserveDeep(onFrame)
  })

  /*
   * Записи, занявшие место строки-обещания: им НЕ играют появление.
   *
   * Строка-обещание и настоящая запись — один и тот же вопрос, но ключи у них
   * разные (`outgoing:N` против серверного id), так что Svelte честно сносит
   * один <article> и монтирует другой. С `animate-fade-up` на нём тот же
   * вопрос на том же месте проявлялся из прозрачности второй раз — рывок
   * ровно там, где ask-outbox обещал незаметную замену.
   *
   * Кто кого заменил, спрашивается у самого `settleOutbox`, а не считается
   * здесь заново: правило совпадения живёт в одном месте, и вторая его копия
   * разошлась бы с первой на первой же правке.
   */
  let inherited = $state.raw<ReadonlySet<string>>(new Set())

  function landedIds(
    before: readonly Outgoing[],
    after: readonly Outgoing[],
    fresh: readonly ChatSnapshot[],
  ): string[] {
    const gone = before.filter((row) => !after.includes(row))
    const out: string[] = []
    for (const row of gone) {
      for (const entry of fresh) {
        if (out.includes(entry.id)) continue
        if (settleOutbox([row], [entry]).length > 0) continue
        out.push(entry.id)
        break
      }
    }
    return out
  }

  /**
   * Состояние оракула на инстансе — и «не знаю» отдельно от «выключен».
   *
   * Отвергнутая выборка (сеть моргнула, 5xx, ретранслятор) раньше ложилась
   * как `{enabled:false, mode:'off'}`, и класс читал решение админа там, где
   * была одна неудачная попытка: «оракул выключен для этого инстанса», поля
   * ввода нет, повтора нет — поправиться могло только перемонтированием
   * панели. Теперь `status` остаётся `null` (то есть «ещё проверяем», как и
   * задумано выше), а внизу стоит строка с кнопкой повтора.
   */
  let statusFailed = $state(false)
  let statusTry = $state(0)

  $effect(() => {
    void statusTry
    let alive = true
    api
      .aiStatus()
      .then((res) => {
        if (!alive) return
        status = res
        statusFailed = false
      })
      .catch(() => {
        if (!alive) return
        // Именно null: 'off' говорит только сервер.
        status = null
        statusFailed = true
      })
    return () => {
      alive = false
    }
  })

  /*
   * Здесь стоял наблюдатель `errored` — «где-то в комнате упала ячейка».
   *
   * Его никто не рисовал: значение писалось и не читалось ни в скрипте, ни в
   * разметке. Стоил он при этом дорого — на каждую вставку и удаление ячейки
   * в ЛЮБОЙ тетради комнаты он снимал и заново вешал наблюдателя на все Y.Map
   * всех тетрадей, в каждой из пятисот вкладок с открытой панелью. Работа без
   * результата на экране — не оптимизация, а мусор, и убран он целиком: если
   * красная точка «где-то упало» понадобится, считать её надо по реестру
   * ячеек (`yreactive`), а не подпиской на каждую.
   */

  // The notebook asks on the student's behalf from "Ask AI" and "Fix with AI".
  $effect(() => {
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<{ cellId?: string; action?: AiAction }>).detail
      if (!detail) return
      void ask({
        message: '',
        action: detail.action ?? 'explain',
        cellId: detail.cellId ?? session.selectedCellId,
      })
    }
    window.addEventListener('colloq:ask-ai', onAsk)
    return () => window.removeEventListener('colloq:ask-ai', onAsk)
  })

  $effect(() => () => {
    window.clearTimeout(armTimer)
    // Leaving with text in the box must not leave a ghost typing line behind.
    stopComposing()
  })

  /* -------------------------------------------------------------- reading */

  const avatars = $derived.by(() => {
    const map = new Map<string, string | null>()
    for (const peer of session.peers) {
      if (peer.user.avatar) map.set(peer.user.id, peer.user.avatar)
    }
    return map
  })

  /**
   * Роль автора по его id — один проход по присутствию на всю ленту.
   *
   * Каждый ход спрашивал её у `session.peers` поиском, а `#readPeers` отдаёт
   * новый массив на КАЖДЫЙ чужой курсор: двести ходов на пятистах человек —
   * сто тысяч сравнений на каждый переход студента между ячейками, и так в
   * каждой вкладке с открытой панелью. Здесь это один проход, и просыпается
   * он тогда же, когда меняется присутствие.
   */
  const roles = $derived.by(() => {
    const map = new Map<string, ParticipantRole>()
    for (const peer of session.peers) map.set(peer.user.id, peer.user.role)
    return map
  })

  /** One line per person, not per tab — two tabs are still one student. */
  const typing = $derived.by(() => {
    const seen = new Map<string, AwarenessUser>()
    for (const peer of session.peers) {
      if (peer.user.id === session.me.id || !peer.user.composing) continue
      if (!seen.has(peer.user.id)) seen.set(peer.user.id, peer.user)
    }
    return [...seen.values()]
  })

  const typingLine = $derived.by(() => {
    const names = typing.map((user) => user.name)
    if (names.length === 0) return null
    if (names.length === 1) return tr('room.ui.519', { p0: names[0] })
    if (names.length === 2) return tr('room.ui.520', { p0: names[0], p1: names[1] })
    return tr('room.ui.521', { count: names.length })
  })

  /**
   * Что оракул видит — и на что смотрит особенно.
   *
   * Две строки вместо ряда чипов, и это не косметика. Чипы перечисляли выбранную
   * ячейку, трейсбек и несколько имён файлов — то есть КУСКИ того, что и так
   * едет целиком, — а про тетрадь и остальные файлы молчали, потому что «чип,
   * который горит всегда, ничего не говорит». Получалось ровно наоборот: список
   * из трёх имён читался как «вот это он и видит», и человек не понимал, почему
   * ответ знает про соседнюю ячейку.
   *
   * Теперь сказано прямо: базово видно всё, что есть в комнате. А выделение и
   * открытый файл ДОБАВЛЯЮТСЯ к этому — как то, на чём просят сосредоточиться.
   */
  const books = watchBooks(session.doc)

  /*
   * Файлы, КРОМЕ тетрадей: тетради названы отдельно, и складывать их дважды
   * значит обещать больше, чем в комнате есть.
   */
  const fileCount = $derived(
    session.files.filter((file) => !file.dir && kindOf(file.path) !== 'notebook').length,
  )

  const seesAll = $derived.by(() => {
    const nb = books.current.length
    return (
      `${nb} ${plural(nb, tr('room.ui.522'), tr('room.ui.523'), tr('room.ui.524'))}` +
      tr('room.ui.525', { p0: fileCount })
    )
  })

  /** Открытый текстовый файл едет целиком; тетрадь — нет: она и так в ячейках. */
  const openFile = $derived(
    session.editingPath && kindOf(session.editingPath) === 'text' ? session.editingPath : null,
  )

  const focusNumbers = $derived(
    session.selection
      .map((id) => cellNumbers.current.get(id))
      .filter((n): n is number => n !== undefined)
      .sort((a, b) => a - b)
      .map(pad),
  )

  /**
   * То же самое двумя падежами.
   *
   * Строка «Особенно» перечисляет — там именительный; подсказка в поле стоит
   * после предлога — там винительный. «Спросить про ячейка 02» бросается в
   * глаза сильнее, чем стоит эта пара строк.
   */
  const focus = $derived.by(() => {
    const parts: string[] = []
    if (focusNumbers.length === 1) parts.push(tr('room.ui.526', { p0: focusNumbers[0] }))
    else if (focusNumbers.length > 1) parts.push(tr('room.ui.527', { p0: focusNumbers.join(', ') }))
    if (openFile) parts.push(openFile)
    return parts
  })

  const focusAsked = $derived.by(() => {
    if (focusNumbers.length === 1) return tr('room.ui.528', { p0: focusNumbers[0] })
    if (focusNumbers.length > 1) return tr('room.ui.527', { p0: focusNumbers.join(', ') })
    return openFile
  })

  function cellNumber(id: string | null | undefined): number | null {
    if (!id) return null
    return cellNumbers.current.get(id) ?? null
  }

  /** Cells are named 01…04 in the gutter; the thread has to agree with it. */
  function pad(n: number): string {
    return String(n).padStart(2, '0')
  }

  /* ------------------------------------------------------------- scrolling */

  function toBottom(): void {
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }

  $effect(() => {
    const tail = entries[entries.length - 1]
    // Depend on the tail's length too, or a streaming answer scrolls out of view.
    void entries.length
    void tail?.answer.length
    if (!pinned || !scroller) return
    // After the DOM has the new text, not before.
    requestAnimationFrame(() => {
      if (pinned) toBottom()
    })
  })

  /*
   * СЛЕДОВАТЬ ЗА РАСТУЩИМ, А НЕ ТОЛЬКО ЗА НОВЫМ.
   *
   * Прежний эффект просыпался на приход записи. Но высота треда меняется и без
   * новых записей: ответ дописывается в уже стоящий пузырь, под последним
   * поворотом появляется строка «Нина печатает», поле вопроса растёт до ста
   * шестидесяти пикселей и отъедает их у треда. Ни одно из этого не двигает
   * прокрутку само, и низ тихо уезжает под нижний край: на мерке тред уползал
   * на 37 пикселей за один вопрос и оставался там до следующего.
   *
   * Наблюдатель размера смотрит и за содержимым, и за самим окном треда —
   * второе как раз про выросшее поле ввода.
   */
  $effect(() => {
    const box = scroller
    const inner = thread
    if (!box || !inner) return
    const watch = new ResizeObserver(() => {
      if (pinned) toBottom()
    })
    watch.observe(inner)
    watch.observe(box)
    return () => watch.disconnect()
  })

  /**
   * Где тред стоял в прошлый раз, чтобы отличить «читатель ушёл вверх» от
   * «содержимое выросло». Не руна: её никто не рисует.
   */
  let lastTop = 0

  function onScroll() {
    if (!scroller) return
    const el = scroller
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    /*
     * ОТЦЕПИТЬСЯ ОТ НИЗА МОЖЕТ ТОЛЬКО ЧЕЛОВЕК.
     *
     * Событие прокрутки приходит и от нашей собственной строки
     * `scrollTop = scrollHeight`, и раньше оно же тред и отцепляло: пока
     * событие шло до обработчика, ответ дописывался, `scrollHeight` успевал
     * подрасти, и мы честно вычисляли «до низа далеко» — то есть сами себе
     * ставили «читатель ушёл вверх». Дальше тред стоял мёртво, а вопросы
     * аудитории уходили под край. Ровно на это и пожаловались.
     *
     * Признак человека один и надёжный: прокрутка ВВЕРХ. Ни рост содержимого,
     * ни наша собственная строка `scrollTop` не уменьшают. Пиксель допуска —
     * на дробную прокрутку при масштабе, отличном от ста процентов.
     */
    const wentUp = el.scrollTop < lastTop - 1
    lastTop = el.scrollTop
    if (gap < 40) {
      pinned = true
      mark = null
      return
    }
    if (!wentUp || !pinned) return
    pinned = false
    const tail = entries[entries.length - 1]
    mark = tail ? { id: tail.id, length: tail.answer.length } : { id: '', length: 0 }
  }

  /**
   * Whether something arrived below while the reader was looking elsewhere.
   *
   * Both halves count: a whole new question from somebody else, and more of an
   * answer that was already there. The second is the common one — a student
   * scrolls up to re-read cell 03's explanation and the answer they are waiting
   * for finishes underneath them.
   */
  const news = $derived.by(() => {
    if (pinned || !mark) return null
    const tail = entries[entries.length - 1]
    if (!tail) return null
    if (tail.id === mark.id && tail.answer.length <= mark.length) return null
    return tail
  })

  function follow() {
    pinned = true
    mark = null
    toBottom()
  }

  /* ------------------------------------------------------------- composing */

  /**
   * Debounced in both directions: one keystroke should not broadcast, and a
   * pause to think should not yank the line out of everyone else's panel.
   */
  function announceComposing(active: boolean) {
    window.clearTimeout(composeTimer)
    if (active === composingSent) return
    composeTimer = window.setTimeout(
      () => {
        composingSent = active
        session.setComposing(active)
      },
      active ? 220 : 600,
    )
  }

  function stopComposing() {
    window.clearTimeout(composeTimer)
    if (!composingSent) return
    composingSent = false
    session.setComposing(false)
  }

  /* ---------------------------------------------------------------- asking */

  /*
   * Обратный отсчёт слоу-мода — только показ.
   *
   * Своего счёта времени у вкладки нет и быть не должно: промежуток
   * считает сервер по своей таблице расхода, а здесь тикает число, которое он
   * назвал в отказе. Вкладка с отстающими часами просто получит отказ ещё раз —
   * гашеная кнопка избавляет от лишнего круга, а не решает за сервер.
   */
  $effect(() => {
    if (waitUntil === 0) return
    let timer = 0
    const tick = () => {
      const left = Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000))
      waitLeft = left
      if (left === 0) {
        // Строка уходит вместе с ожиданием: «ещё десять секунд», висящее
        // после того как они прошли, — уже неправда.
        slowNoticeRender = () => (null)
        waitUntil = 0
        return
      }
      timer = window.setTimeout(tick, 250)
    }
    tick()
    return () => window.clearTimeout(timer)
  })

  async function ask(body: AiAskRequest) {
    if (offline) return
    stopComposing()
    sendErrorRender = () => (null)
    pinned = true
    // Строка встаёт в ленту здесь, а не в `submit`: спрашивают ещё из тетради
    // («Спросить оракула», «Починить») и повтором хода, и ждут они ровно
    // столько же.
    const outgoingId = openOutbox(body)
    try {
      const { entryId } = await api.aiAsk(session.session.id, session.token, body)
      outbox = outbox.map(row => row.row.id === outgoingId ? { ...row, entryId } : row)
      // The document may arrive before HTTP, including an already finished
      // answer. Reconcile now as well as on the next document update.
      settlePending(entries)
      slowNoticeRender = () => (null)
      waitUntil = 0
    } catch (err) {
      // Вопрос не принят — значит и в ленте ему не место: строка, оставшаяся
      // висеть с вертушкой, обещает ответ, которого не будет.
      closeOutbox(outgoingId)
      // Verbatim: a 403 ("hints mode…", "switched off…") and a 429 with the
      // minutes until the next question are the server explaining an
      // instance's rules, and paraphrasing them would leave the student
      // guessing at a limit only the server knows.
      //
      // Срок в теле — это ожидание, а не поломка: слоу-мод говорит спокойной
      // строкой и гасит кнопку, а не красной плашкой, похожей на аварию.
      /*
       * И вопрос — обратно в поле, ЛЮБЫМ отказом.
       *
       * `submit` очищает поле до ответа сервера, и это правильно: строка уже
       * стоит в ленте. Но если сервер вопрос не принял — потолок в час (429 с
       * заголовком Retry-After и без срока в теле), правило комнаты (403,
       * звонок), обрыв через ретранслятор, любой 5xx, — то вместе с отказом
       * пропадали и пять набранных строк, и вернуть их было нечем. Возврат
       * стоит ДО разбора причины, потому что причина на это не влияет; только
       * если человек уже начал печатать заново — его текст важнее нашего.
       */
      if (composing.question.trim() === '') composing.question = body.message
      if (err instanceof ApiError && err.retryAfter !== null && err.retryAfter > 0) {
        slowNoticeRender = () => (tr(err.message))
        waitUntil = Date.now() + err.retryAfter * 1000
        return
      }
      sendErrorRender = () => (err instanceof Error ? tr(err.message) : tr('room.ui.529'))
    }
  }

  /**
   * Спросить или сделать.
   *
   * Переключатель, а не догадка по формулировке: «перепиши train.py» — это и
   * вопрос, и поручение, в зависимости от того, чего человек хочет, и угадывать
   * тут значит иногда молча трогать чужие файлы. Стоит рядом с полем, помнится
   * между вопросами и гаснет там, где режим запрещён правилом комнаты.
   */
  let doing = $state(false)
  const may = $derived(permitsIn(session.session.rules, session.me.role, session.finished))
  const mayDo = $derived(may.agent)
  /*
   * И режим оракула, а не только правило `agent`.
   *
   * В режиме подсказок сервер отказывает поручению безусловно: оракул, который
   * не пишет ответ за студента, тем более не пишет его в файл. Переключателю
   * там нечего предлагать — «нет вовсе» вместо «есть и отказывает».
   */
  const canDo = $derived(mayDo && !hintsOnly)
  /*
   * Правило меняют посреди пары — переключатель уходит вместе со своим
   * положением. Иначе комната, вернувшаяся из подсказок, встречает человека
   * взведённым «Сделать», которого он не выбирал.
   */
  $effect(() => {
    if (!canDo) doing = false
    /*
     * И «Иван печатает вопрос…» — тем же движением.
     *
     * Строка живёт в присутствии, а не в этом компоненте: поле после звонка
     * исчезает целиком, ни `blur`, ни ввода больше не будет, и снять флаг
     * некому — он висит у всей комнаты до перезагрузки вкладки. Иван при этом
     * уже ничего не печатает: спрашивать ему нечем.
     */
    if (!may.ask) stopComposing()
  })

  function submit() {
    const message = composing.question.trim()
    if (!message || waitLeft > 0) return
    composing.question = ''
    if (composer) {
      composer.style.height = 'auto'
      composer.focus()
    }
    if (doing && canDo) {
      void ask({ message, mode: 'agent' })
      return
    }
    void ask({ message, action: 'ask', cellIds: [...session.selection] })
  }

  /** Отменить ход целиком: файлы возвращаются к тому, что было до него. */
  function undo(entryId: string) {
    session.send({ t: 'ai:undo', entryId })
  }

  function retry(entry: ChatSnapshot) {
    /*
     * Повтор поручения — поручение.
     *
     * Без `mode` «почини train.py и запусти» уходило обычным вопросом: модель
     * объясняла, что сделала бы, и не делала ничего, — а нажимали Retry ровно
     * под ходом «сделать». Действие и ячейка агенту не передаются: у него их
     * не было и в первый раз.
     */
    if (entry.mode === 'agent') {
      void ask({ message: entry.question, mode: 'agent' })
      return
    }
    /*
     * Все ячейки, о которых спрашивали, а не только первая: «объясни 02, 03 и
     * 05», повторённый после обрыва, уходил вопросом про 02, и в шапке нового
     * хода стояла одна ячейка из трёх.
     */
    void ask({
      message: entry.question,
      action: (entry.action as AiAction | null) ?? undefined,
      cellId: entry.cellId,
      cellIds: [...entry.cellIds],
    })
  }

  async function stop(entryId: string) {
    try {
      await api.aiCancel(session.session.id, session.token, entryId)
    } catch (err) {
      sendErrorRender = () => (err instanceof Error ? tr(err.message) : tr('room.ui.530'))
    }
  }

  async function clearThread() {
    // Two-step: this wipes what the whole class asked, and the button sits one
    // pixel from the model name.
    if (!armed) {
      armed = true
      armTimer = window.setTimeout(() => (armed = false), 3000)
      return
    }
    window.clearTimeout(armTimer)
    armed = false
    try {
      await api.aiClearThread(session.session.id, session.token)
    } catch (err) {
      sendErrorRender = () => (err instanceof Error ? tr(err.message) : tr('room.ui.531'))
    }
  }

  function onInput(event: Event) {
    const el = event.currentTarget as HTMLTextAreaElement
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
    announceComposing(el.value.trim().length > 0)
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    submit()
  }
</script>

<div class="panel h-full">
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
    <Icon name="sparkles" size={14} class="shrink-0 text-accent-text" />
    <span class="shrink-0 text-2xs font-bold uppercase tracking-section text-ink">{tr('room.ui.488')}</span>
    <span
      class="inline-flex h-5 shrink-0 items-center bg-raised px-1.5 text-2xs font-bold uppercase
             tracking-caps text-ink"
      title={tr('room.ui.489')}
    > {tr('room.ui.490')} {entries.length}
    </span>

    <span class="ml-auto min-w-0 truncate font-mono text-2xs text-muted">
      <!--
        Only when there is something to name. A header reading "gpt-4o-mini"
        above a panel saying "no model is set up on this Colloq yet" is the
        screen contradicting itself: the model is what the server WOULD use, and
        until it can, saying it is a claim the room cannot act on.
      -->
      {offline ? '' : (status?.model ?? '')}
    </span>

    {#if isHost}
      <button
        type="button"
        class="btn-ghost h-7 shrink-0 gap-1 px-1.5 text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 {armed
          ? 'text-danger hover:text-danger'
          : ''}"
        title={tr('room.ui.492')}
        aria-label={tr('room.ui.492')}
        disabled={entries.length === 0}
        onclick={clearThread}
      >
        <Icon name="eraser" size={14} />
        {#if armed}<span>{tr('room.ui.493')}</span>{/if}
      </button>
    {/if}
  </div>

  <div class="relative flex min-h-0 flex-1 flex-col">
    <div bind:this={scroller} onscroll={onScroll} class="min-h-0 flex-1 overflow-y-auto">
      <!-- Обёртка нужна наблюдателю размера: он смотрит за высотой СОДЕРЖИМОГО,
           а у самого окна прокрутки она не меняется, сколько бы туда ни дописали. -->
      <div bind:this={thread}>
      {#if entries.length === 0 && outbox.length === 0}
        <!--
          The first thing a student reads on this panel, so it is not "nothing
          here yet" — it is the one rule about this thread worth knowing before
          you use it.
        -->
        <div class="flex flex-col items-start gap-2.5 px-4 pb-4 pt-4">
          <p class="text-answer text-ink">{tr('room.ui.494')}</p>
          <p class="text-ui text-muted"> {tr('room.ui.495')} </p>
          <!--
            «Выделите ячейку, чтобы спросить о ней» было неправдой ровно
            наоборот: вопрос и без выделения уезжал вместе со всей тетрадью, а
            строка советовала сделать обязательным то, что всего лишь наводит
            фокус.
          -->
          <p class="text-ui text-muted"> {tr('room.ui.496')} </p>
        </div>
      {/if}

      {#each [...entries, ...outbox.map((row) => row.row)] as entry (entry.id)}
        <ChatTurn
          {entry}
          pending={entry.id.startsWith('outgoing:')}
          avatar={avatars.get(entry.participantId) ?? null}
          authorRole={roles.get(entry.participantId) ?? 'participant'}
          enter={!inherited.has(entry.id)}
          cellNumber={cellNumber(entry.cellId)}
          askedAbout={(entry.cellIds.length > 0 ? entry.cellIds : entry.cellId ? [entry.cellId] : [])
            .map((id) => cellNumber(id))
            .filter((n): n is number => n !== null)
            .sort((a, b) => a - b)}
          {canDo}
          onretry={() => retry(entry)}
          onstop={() => void stop(entry.id)}
          onundo={() => undo(entry.id)}
        />
      {/each}

      {#if typingLine}
        <!-- Under the last turn rather than inside the thread: this is an
             intention, and the thread holds finished facts. -->
        <div class="flex items-center gap-2 px-4 pb-4 pt-2 text-2xs italic text-muted">
          <span class="flex shrink-0 -space-x-1.5">
            {#each typing.slice(0, 3) as user (user.id)}
              <Avatar size="xs" ring name={user.name} color={user.color} avatar={user.avatar} />
            {/each}
          </span>
          <span class="min-w-0 truncate">{typingLine}</span>
        </div>
      {/if}
      </div>
    </div>

    {#if news}
      <!--
        The thread stops chasing the newest answer the moment somebody scrolls
        back, because reading beats following. Doing that silently, though, is
        how an answer gets lost, so it says whose it is.
      -->
      <div class="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
        <button
          type="button"
          class="pointer-events-auto inline-flex h-[26px] animate-fade-up items-center gap-1.5
                 border border-line bg-canvas pl-1.5 pr-2.5 shadow-pop
                 transition-colors duration-[var(--speed-quick)] hover:border-faint
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onclick={follow}
        >
          <Avatar
            size="xs"
            name={news.name}
            color={news.color}
            avatar={avatars.get(news.participantId) ?? null}
          />
          <span class="text-2xs font-semibold text-ink">
            {news.participantId === session.me.id ? tr('room.ui.497') : tr('room.ui.498', { p0: news.name })}
          </span>
          <Icon name="chevron-down" size={11} class="text-accent-text" />
        </button>
      </div>
    {/if}
  </div>

  <div class="flex shrink-0 flex-col gap-2.5 border-t border-line px-4 pb-4 pt-3">
    {#if sendError}
      <div
        class="flex items-start gap-2 border-l-2 border-danger bg-danger/[0.05] px-3 py-2 text-2xs text-danger"
      >
        <span class="min-w-0 flex-1 break-words">{sendError}</span>
        <button
          type="button"
          class="shrink-0 p-0.5 transition-colors duration-100 hover:bg-danger/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
          aria-label={tr('room.ui.499')}
          onclick={() => (sendErrorRender = () => null)}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    {/if}

    {#if statusFailed}
      <!--
        «Не знаю» — это не «выключен».

        Одна отвергнутая выборка /api/ai/status раньше становилась плашкой
        «оракул выключен для этого инстанса» и уносила с собой поле ввода:
        решение админа на месте сетевого сбоя, и без повтора. Поле остаётся —
        сервер решает всё равно сам, — а строка говорит ровно то, что есть.
      -->
      <p class="flex items-center gap-2 border border-line bg-raised px-3 py-2 text-2xs text-muted">
        <span class="min-w-0 flex-1">{tr('room.ui.500')}</span>
        <button
          type="button"
          class="btn-ghost press h-6 shrink-0 px-1.5 text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onclick={() => (statusTry += 1)}
        > {tr('room.ui.501')} </button>
      </p>
    {/if}

    {#if slowNotice}
      <!--
        Ожидание, а не ошибка: тот же спокойный вид, что у правил ниже.
        Сама строка — серверная, слово в слово: промежуток знает только он.
      -->
      <p class="border border-line bg-raised px-3 py-2 text-2xs text-muted" role="status">
        {slowNotice}
      </p>
    {/if}

    {#if hintsOnly}
      <!--
        «Просят подсказку», а не «решения не будет».

        Режим подсказок держится на формулировке запроса к модели: мы просим не
        давать решение, повторяем эту просьбу после слов студента — и на этом
        всё, потому что больше сделать нечего. Обещать классу, что решение не
        появится, значит обещать за модель.

        Строка осталась там, где стояли кнопки: она про комнату, а не про
        кнопку, и исчезнуть вместе с ними не должна была.
      -->
      <p class="text-2xs text-muted"> {tr('room.ui.502')} </p>
    {/if}

    {#if offline}
      <!--
        Two different facts wore the same sentence, and it was addressed to
        whoever runs the server while being read by a student who cannot act on
        it. An oracle switched off by the teacher is a decision, not a fault;
        an unconfigured one is a fault, and only staff can do anything about it —
        so only staff are told where.

        Выключен — кем: сервер различает решение админа и решение
        преподавателя (routes/ai.ts), и панель обязана называть то же самое,
        иначе решение админа приходит классу как решение преподавателя.

        А вот «ключа нет» и «лимит ноль» /api/ai/status одинаково отдаёт как
        `enabled: false`, и различить их отсюда нечем — поэтому подсказка хосту
        называет оба места сразу, а не то, которое у него уже настроено.
      -->
      <p class="border border-line bg-raised px-3 py-2 text-2xs text-muted">
        {#if mode === 'off'}
          {#if status?.mode === 'off'} {tr('room.ui.503')} {:else} {tr('room.ui.504')} {/if}
        {:else if isHost} {tr('room.ui.505')} <span class="font-semibold text-ink">{tr('room.ui.488')}</span> {tr('room.ui.506')} {:else} {tr('room.ui.507')} {/if}
      </p>
    {:else if !may.ask}
      <!--
        Занятие кончилось — поля нет вовсе, а не есть и отказывает.
        Тред при этом остаётся открытым и прокручивается: за разбором,
        который оракул написал на паре, сюда как раз и возвращаются.
      -->
      <p class="border border-line bg-raised px-3 py-2 text-2xs text-muted">{may.askWhy}</p>
    {:else}
      <div
        class="flex flex-col items-stretch border border-line bg-surface transition-colors
               duration-[var(--speed-quick)] focus-within:border-accent focus-within:ring-4
               focus-within:ring-accent/15"
      >
        <!--
          What this question will carry, attached to the box it will leave from.
          It used to sit above the whole thread, which read as a fact about the
          room; it is not one. Every chip here comes off THIS browser's
          selection, so two people looking at the same panel see two different
          rows — and the only place that is honest is against the field where
          the person who owns that selection is typing.

          Named piece by piece, and nothing is claimed that this browser cannot
          verify: ai/context.ts also sends the whole notebook, the kernel status
          and the file list, which have no chip because they are unconditional
          and a chip that is always lit says nothing.
        -->
        <!--
          Что уедет с этим вопросом — над самим полем, а не над лентой: это
          факт про ЭТУ вкладку, а не про комнату. Выделение у каждого своё, и
          двое, глядящие на одну панель, видят здесь разное.
        -->
        <div class="flex flex-col gap-0.5 border-b border-line px-2 py-1.5">
          <div class="flex items-baseline gap-1.5">
            <span
              class="shrink-0 text-2xs font-bold uppercase tracking-institution text-muted"
              title={tr('room.ui.508')}
            > {tr('room.ui.509')} </span>
            <span class="min-w-0 truncate text-2xs text-muted">{seesAll}</span>
          </div>
          {#if focus.length > 0}
            <!-- Появляется только когда есть на чём сосредоточиться: строка,
                 которая горит всегда, ничего не говорит. -->
            <div class="flex items-baseline gap-1.5">
              <span
                class="shrink-0 text-2xs font-bold uppercase tracking-institution text-accent-text"
                title={tr('room.ui.510')}
              > {tr('room.ui.511')} </span>
              <span class="min-w-0 truncate font-mono text-2xs text-ink">
                {focus.join(' · ')}
              </span>
            </div>
          {/if}
        </div>

        <!--
          Спросить или сделать — переключателем, а не догадкой по формулировке.
          «Перепиши train.py» — это и вопрос, и поручение; угадывать значит
          иногда молча трогать чужие файлы. Там, где режим закрыт — правилом
          комнаты или режимом подсказок, — переключателя нет вовсе, а не есть и
          отказывает.
        -->
        {#if canDo}
          <div class="flex items-center gap-1 px-2 pb-0.5 pt-1.5">
            <div class="flex items-stretch border border-line bg-canvas">
              <button
                type="button"
                class="px-2 py-0.5 text-2xs font-semibold transition-colors duration-100
                       {doing ? 'text-muted hover:text-ink' : 'bg-primary text-primary-ink'}"
                onclick={() => (doing = false)}
              > {tr('room.ui.513')} </button>
              <button
                type="button"
                class="px-2 py-0.5 text-2xs font-semibold transition-colors duration-100
                       {doing ? 'bg-primary text-primary-ink' : 'text-muted hover:text-ink'}"
                onclick={() => (doing = true)}
              > {tr('room.ui.514')} </button>
            </div>
          </div>
        {/if}

        <div class="flex items-end gap-2 py-1 pl-2 pr-1.5">
        <!-- Your face before you type, so it is obvious the room will see this. -->
        <Avatar
          class="mb-1"
          size="xs"
          name={session.me.name}
          color={session.me.color}
          avatar={session.me.avatar}
          title={tr('room.oracle.asker', { name: session.me.name })}
        />
        <!-- Метка для «Спросить оракула» с клавиатуры: ⌘/Ctrl+I и строка
             палитры ставят фокус сюда (SessionScreen · focusOracle). На самом
             поле, а не на панели: запасной путь `[data-oracle-panel] textarea`
             держится на том, что поле ввода в панели ровно одно, и второе поле
             здесь — правка вопроса, черновик ответа — увело бы фокус молча. -->
        <textarea
          bind:this={composer}
          data-oracle-composer
          bind:value={composing.question}
          rows="1"
          placeholder={doing && canDo
            ? tr('room.extra.217')
            : focusAsked
              ? tr('room.extra.218', { p0: focusAsked })
              : tr('room.extra.219')}
          title={tr('room.ui.515')}
          class="max-h-40 flex-1 resize-none bg-transparent py-1 text-ui text-ink placeholder:text-muted focus:outline-none"
          oninput={onInput}
          onkeydown={onKeydown}
          onblur={() => {
            if (!composing.question.trim()) stopComposing()
          }}
        ></textarea>
        <!--
          Пока идёт промежуток, кнопка показывает секунды вместо самолётика.
          Число тикает у отправки, а не в строке над полем: там стоит правило,
          и переписывать его каждую секунду значит мигать текстом, который
          человек в это время читает.
        -->
        <button
          type="button"
          class="btn-primary h-7 w-7 shrink-0 px-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={waitLeft > 0 ? tr('room.extra.220', { p0: waitLeft }) : tr('room.extra.221')}
          title={waitLeft > 0 ? (slowNotice ?? '') : ''}
          disabled={!composing.question.trim() || waitLeft > 0}
          onclick={submit}
        >
          {#if waitLeft > 0}
            <span class="font-mono text-2xs font-bold tabular-nums">{waitLeft}</span>
          {:else}
            <Icon name="send" size={14} />
          {/if}
        </button>
        </div>
      </div>
    {/if}

    <p class="flex items-center gap-1.5 text-2xs text-muted">
      <Icon name="users" size={13} class="shrink-0" />
      <span class="min-w-0">
        {doing && canDo
          ? tr('room.ui.516')
          : tr('room.ui.517')}
      </span>
    </p>
  </div>
</div>
