<script lang="ts" module>
  import { tr, getLocale } from '@shared/i18n'
  import { api } from '@/lib/api'
  import { actionAllowedIn, councilLetters } from '@shared/protocol'

  /**
   * "Fix with AI" is drawn only where there is an oracle that will take a
   * 'fix'. An oracle in hints mode is on, and would refuse this button — so
   * `enabled` alone is the wrong question and actionAllowedIn is the right one,
   * asked with the same function the route refuses with.
   *
   * Every failing cell asks the same question, so the answer is fetched once
   * per tab and shared: a status request per cell would be one request per
   * traceback.
   */
  let oracle: Promise<{ enabled: boolean; mode: 'off' | 'hints' | 'full' }> | null = null

  /**
   * What the instance allows, once per tab.
   *
   * Narrowing to this room happens at the call site: the instance's answer
   * knows nothing about a seminar, and a room may be stricter than it. Asked
   * here it would draw "Fix with AI" in a hints-only seminar and every press
   * would come back 403.
   */
  function oracleStatus(): Promise<{ enabled: boolean; mode: 'off' | 'hints' | 'full' }> {
    oracle ??= api
      .aiStatus()
      .then((status) => ({ enabled: status.enabled, mode: status.mode }))
      .catch((cause: unknown) => {
        /*
         * Отказ не запоминается. Раньше он превращался в заглушку «оракула
         * нет», и вкладка, открытая в момент перезапуска сервера, до конца
         * пары не рисовала «Fix with AI» ни под одним трейсбеком — при том что
         * панель оракула рядом спрашивает статус заново и показывает модель.
         */
        oracle = null
        throw cause
      })
    return oracle
  }
</script>

<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import { slide } from 'svelte/transition'
  import { quintOut } from 'svelte/easing'
  import * as Y from 'yjs'
  import { Awareness } from 'y-protocols/awareness'
  import {
    cellSource,
    COUNCIL_SHARED_KERNEL_NOTE,
    DEFAULT_COUNCIL,
    MAX_ATTEMPT_CHARS,
    patchIsStale,
    replaceText,
    type CellLock,
    type CouncilSettings,
  } from '@shared/notebook'
  import { diffCounts, diffLines } from '@shared/diff'
  import type { AiAction } from '@shared/protocol'
  import { actsAfterClass, CLASS_IS_OVER, oracleModeIn, readRules } from '@shared/rules'
  import {
    cellLockMatters,
    COUNCIL_CLOSED,
    COUNCIL_SHARED_CELL,
    LECTURE_CELL,
    mayEditThisCell,
    mayRunThisCell,
    mayRunThisCouncil,
    mayWriteThisCouncil,
    permitsIn,
  } from '@/lib/may'
  import {
    attemptCounter,
    attemptInSync,
    attemptTooLong,
    countLine,
    queueWords,
    ranByLine,
    sheetSeed,
    watchCellLock,
  } from '@/lib/council.svelte'
  import { clock } from '@/lib/history'
  import CouncilStack from '@/components/council/CouncilStack.svelte'
  import CouncilOnScreen from '@/components/council/CouncilOnScreen.svelte'
  import {
    beatsAlive,
    openPult,
    watchPult,
    type PultBeat,
  } from '@/lib/council-pult-window'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon, { type IconName } from '@/components/ui/Icon.svelte'
  import CodeLine from '@/components/ui/CodeLine.svelte'
  import {
    deleteCell,
    duplicateCell,
    hasPendingRun,
    insertCellAfter,
    ONE_AT_A_TIME,
    setCellType,
  } from '@/lib/notebook-ops'
  import { controlDisabled, controlTitle } from '@/lib/controls'
  import { lockHint, lockLabel, lockPress } from '@/lib/lock-button'
  import { getSessionState } from '@/lib/session.svelte'
  import { cn, elapsed, NOTICED_MS, prefersReducedMotion, spell } from '@/lib/utils'
  import { copyText } from '@/lib/clipboard'
  import { diffTokens, loadSyntax, syntax } from '@/lib/syntax.svelte'
  import {
    watchCell,
    watchCellMeta,
    watchCellPeers,
    watchNotebookMeta,
    watchOutputs,
    watchPatchFor,
    watchText,
  } from '@/lib/yreactive.svelte'
  import { runSlot } from '@/lib/run-slot'
  import {
    nextHeld,
    NO_HELD,
    outputSeat,
    runMark,
    unnumberedResult,
    type Held,
  } from '@/lib/output-seat'
  import { emptyCellIsRemovable } from './cell-keys'
  import CellOutputs from './CellOutputs.svelte'
  import CodeEditor from './CodeEditor.svelte'
  import Markdown from './Markdown.svelte'

  interface Props {
    id: string
    /** Корень тетради, в которой эта ячейка: см. Notebook.svelte. */
    bookRoot: string
    index: number
    /** Последняя в тетради: «вниз» ей некуда, и кнопка это показывает. */
    last: boolean
    /** Ячейка входит в выделение — их может быть несколько. */
    selected: boolean
    /**
     * Та самая, с которой работают клавиатура и курсор.
     *
     * Отдельно от `selected`, потому что при выделении нескольких ячеек ровно
     * одна из них остаётся якорем: от неё меряется диапазон, в неё уходит Enter
     * и её видит комната как «правит ячейку 04».
     */
    anchor?: boolean
    /** False while the cell sits far outside the viewport; see Notebook.svelte. */
    near?: boolean
    onselect: (event?: MouseEvent | PointerEvent) => void
  }

  let {
    id,
    bookRoot,
    index,
    last,
    selected,
    anchor = false,
    near = true,
    onselect,
  }: Props = $props()

  const session = getSessionState()
  const cell = watchCell(session.doc, () => id)
  const meta = watchCellMeta(() => cell.current)

  const isCode = $derived(meta.current.type === 'code')
  // The room's own rule, read where the button is drawn — the server has
  // enforced it since rules existed and the interface never asked.
  /*
   * Что в этой комнате можно — одним местом. Правило, которое останавливает,
   * обязано сказать об этом там, где нажимают, и ДО нажатия: кнопка, молча
   * ничего не делающая, читается как поломка и приходит обратно баг-репортом.
   */
  const may = $derived(permitsIn(session.session.rules, session.me.role, session.finished))
  /*
   * Замок на этой ячейке — и три производных, которыми живёт весь компонент.
   *
   * Права считает shared/rules.ts теми же функциями, что и сервер: компонент
   * не складывает правило комнаты с полем ячейки сам. Иначе в продукте было бы
   * два ответа на вопрос «можно ли здесь печатать», и расходиться они начали бы
   * не с кнопкой, а с гейтом, который правку молча отвергает.
   *
   * `lock` — стоит ли рисовать замок вообще. В комнате, где участник и так
   * печатает и запускает, открывать нечего, и значок там был бы украшением;
   * после звонка — тем более, там своя причина и свои слова.
   */
  const cellOpen = $derived(meta.current.open)
  const lock = $derived(cellLockMatters(may))
  const mayEdit = $derived(mayEditThisCell(may, cellOpen))
  const mayRun = $derived(mayRunThisCell(may, cellOpen))
  /** Закрыта для ТЕБЯ: у преподавателя замок висит, но ничего не запирает. */
  const shut = $derived(lock && !mayEdit && !mayRun)
  /*
   * Одна фраза вместо правила комнаты — по тому же доводу, что и `CLASS_IS_OVER`
   * в may.ts: услышать «тетрадь принадлежит преподавателю» там, где ячейку
   * открывают одним нажатием, значит пойти искать не то.
   */
  const editWhy = $derived(shut ? tr(LECTURE_CELL) : may.editWhy)
  /*
   * Действует ли этот человек после звонка — для того, у чего правила нет:
   * ответить на `input()`, отклонить предложение оракула. Та же
   * `actsAfterClass`, которой отвечает сервер.
   */
  const acts = $derived(actsAfterClass(may.finished, session.me.role))

  /* ------------------------------------------------------------ консилиум */

  /*
   * Третье положение замка — консилиум: у каждого свой лист.
   *
   * `meta.current.open` про него не знает намеренно (для гейта и `mayEditCell`
   * консилиум — закрытая ячейка), поэтому положение целиком читает свой
   * наблюдатель. Дальше три роли в одной ячейке: студент пишет СВОЙ лист
   * (`ownSheet`), преподаватель видит общий текст как эталон и под ним пульт
   * (`leads`), а всё остальное — как у закрытой.
   */
  const lockView = watchCellLock(() => cell.current)
  const lockState = $derived(lockView.current.lock)
  const inCouncil = $derived(lockState === 'council')
  const councilSettings = $derived(lockView.current.settings ?? DEFAULT_COUNCIL)
  /** Ведёт консилиум — преподаватель, и после звонка тоже (may.ts · council). */
  const leads = $derived(may.council)
  /** Тело ячейки — свой редактор, а не общий: студент в открытом консилиуме. */
  const ownSheet = $derived(inCouncil && !leads)
  const mine = $derived(session.council.mine[id] ?? null)
  /**
   * Письма преподавателя — по отдельности и в порядке отправки.
   *
   * Их не больше двух: личное и рассылка группе, и живут они рядом, не
   * затирая друг друга (shared/protocol · councilLetters). Склейка в
   * `mine.reply` осталась только для клиентов постарше — в одном абзаце два
   * письма читаются одним: «Проверьте знак Всем: поправка».
   */
  const letters = $derived(councilLetters(mine))
  const count = $derived(session.council.counts[id] ?? null)
  const board = $derived(session.council.boards[id] ?? null)
  /**
   * Что преподаватель вывел на экран по этой ячейке — приезжает ВСЕЙ комнате.
   *
   * Показ больше не переписывает общий текст ячейки: он приходит подписанной
   * плашкой под той же ячейкой (shared/protocol.ts · CouncilShown), а заготовка
   * преподавателя остаётся на месте у всех.
   */
  const onScreen = $derived(session.council.shown[id] ?? null)
  /**
   * Автору второй плашки нет: его код и так перед ним, а два одинаковых блока
   * подряд читаются как ошибка. Про себя он узнаёт раньше всех — по зелёному
   * «Ваш вариант на экране» в подвале своего листа.
   */
  const showsOnScreen = $derived(
    inCouncil && onScreen !== null && onScreen.participantId !== session.me.id,
  )
  /*
   * Консилиум на этой ячейке закрыт — по замку или по слову сервера. Замок
   * приезжает кадром CRDT, `mine.closed` — сокетом; какой из двух дойдёт
   * первым, неизвестно, и закрывает любой.
   */
  const councilClosed = $derived(!inCouncil || (mine?.closed ?? false))
  const mayAttempt = $derived(mayWriteThisCouncil(may, councilClosed))
  const mayRunAttempt = $derived(mayRunThisCouncil(may, councilSettings.studentRun))
  const mayRequestRun = $derived(mayAttempt && councilSettings.studentRun === 'request')
  const attemptRunning = $derived(mine?.run?.state === 'queued' || mine?.run?.state === 'running')
  const submittedAt = $derived(mine?.submittedAt ?? null)
  const attemptWhy = $derived(inCouncil ? may.attemptWhy : tr(COUNCIL_CLOSED))

  /**
   * Свой лист: локальный документ Yjs, ни к чему не подключённый.
   *
   * Тот же CodeEditor, что у ячейки, — он умеет только Y.Text с присутствием и
   * отменой, — поэтому вместо второго редактора здесь второй документ: свой
   * Y.Doc, своё присутствие (никуда не уходит), своя отмена. Ни одной правки в
   * общий Y.Text отсюда нет и быть не может — общего текста в этом документе
   * нет.
   *
   * Живёт до размонтирования, а не до закрытия консилиума: закрытый консилиум
   * оставляет текст человеку черновиком, и черновик — это он.
   */
  interface Sheet {
    doc: Y.Doc
    text: Y.Text
    awareness: Awareness
    undo: Y.UndoManager
  }
  /** Происхождение правок, которые пришли с сервера, а не с клавиатуры. */
  const SEED = 'council:seed'

  function openSheet(seed: string): Sheet {
    const doc = new Y.Doc()
    const text = doc.getText('attempt')
    if (seed) doc.transact(() => text.insert(0, seed), SEED)
    return {
      doc,
      text,
      awareness: new Awareness(doc),
      undo: new Y.UndoManager(text, { trackedOrigins: new Set([null]), captureTimeout: 400 }),
    }
  }

  let sheet = $state.raw<Sheet | null>(null)
  /**
   * Печатал ли человек в своём листе хоть раз.
   *
   * Обычный `let`, не `$state`: читают его эффекты, которые пишут в Y.Text, и
   * сигнал здесь означал бы эффект, зависящий от собственного следствия.
   */
  let typed = false
  /**
   * Что сейчас на листе — строкой, ради двух вопросов о ней.
   *
   * Сигнал, в отличие от `typed`: по нему рисуется счётчик знаков под листом и
   * сверяется «сдано». Строка тут не лишняя копия — `toString()` наблюдатель
   * всё равно делает на каждую правку, чтобы отдать снимок в очередь.
   */
  let sheetText = $state('')
  /** Сколько знаков в попытке — или null, пока до потолка далеко. */
  const attemptCount = $derived(attemptCounter(sheetText.length))
  /** Лист не влезает: снимок такого сервер не примет, и он никуда не уезжает. */
  const attemptOver = $derived(attemptTooLong(sheetText))
  /**
   * У преподавателя лежит ровно то, что человек видит на листе.
   *
   * Сверяется только ради «сдано»: сдаётся ТО, ЧТО ЛЕЖИТ У СЕРВЕРА, и после
   * снимка, который не уехал (лист сверх потолка, отказ, потерянный черновик),
   * «сдано» под длинным текстом было бы неправдой в важном.
   */
  const attemptSynced = $derived(attemptInSync(mine, sheetText))

  $effect(() => {
    if (!ownSheet) return
    if (untrack(() => sheet)) return
    /*
     * Исходный текст — своя попытка, если сервер её уже прислал, иначе задание
     * (sheetSeed: пустая строка от сервера — не попытка). Заданием считается
     * `mine.seed` — текст ячейки на момент перевода замка в консилиум, — а не
     * то, что в ячейке лежит сейчас: после «Показать классу» там уже чужое
     * решение. Пока сервер seed не шлёт, остаётся прежнее поведение.
     * Читается без отслеживания — лист заводят один раз, а не на каждую букву
     * эталона.
     */
    const seed = untrack(() => sheetSeed(mine?.text, mine?.seed ?? liveText.current))
    sheet = openSheet(seed)
  })

  /*
   * Попытка приехала после того, как лист уже завели с общего текста, — и
   * человек ещё ничего не печатал: заменить. Печатал — его текст главнее
   * любого снимка, включая эхо его же снимка.
   *
   * Пустой текст с сервера — не попытка, а «попытки ещё нет» (приветственная
   * пачка по ячейке с открытым консилиумом): стирать им задание из листа
   * нельзя.
   */
  /*
   * И то же для задания: `mine.seed` может доехать после того, как лист уже
   * завели с общего текста (приветственная пачка и кадр CRDT приходят в любом
   * порядке). Пока человек не печатал, задание главнее снимка общей ячейки.
   */
  $effect(() => {
    const current = sheet
    // То же правило, что у `sheetSeed`: своя попытка старше задания. Разница с
    // прежним кодом — в проверке: `undefined` значит «сервер ничего не сказал»
    // (старый сервер, поля нет), а пустая строка — «задание пустое», и ею лист
    // как раз надо очистить: иначе в нём останется показанное решение.
    const text = mine?.text || mine?.seed
    if (!current || text === undefined || typed) return
    if (current.text.toString() === text) return
    current.doc.transact(() => replaceText(current.text, text), SEED)
  })

  /*
   * Снимок при паузе в наборе. Наблюдатель на Y.Text, а не на нажатиях: так
   * ловится и вставка, и отмена, и автодополнение. Правки с происхождением SEED
   * — не набор и не уезжают: иначе эхо снимка порождало бы следующий снимок.
   */
  $effect(() => {
    const current = sheet
    if (!current) return
    const onChange = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      // Зеркало — раньше всех выходов: счётчик под листом обязан считать и то,
      // что приехало заданием, и то, что снимком уже не уедет.
      sheetText = current.text.toString()
      if (transaction.origin === SEED) return
      typed = true
      if (!mayAttempt) return
      // Сверх потолка `draft` снимок не берёт и не шлёт (council.svelte.ts):
      // сервер отвергает его словами, то есть тостом на каждую паузу в наборе.
      // Вместо тоста — счётчик под листом, один и молчащий, пока не важно.
      session.council.draft(id, sheetText)
    }
    sheetText = current.text.toString()
    current.text.observe(onChange)
    return () => current.text.unobserve(onChange)
  })

  // Присутствие держит таймер, документ — память; оба уходят с ячейкой.
  $effect(() => () => {
    const current = untrack(() => sheet)
    if (!current) return
    current.undo.destroy()
    current.awareness.destroy()
    current.doc.destroy()
  })

  /*
   * «Сдать» и «Изменить» ждут эха сервера — и до него кнопка это показывает.
   *
   * Вид попытки меняет только `council:mine` с сервера, а между нажатием и им
   * не было ничего: ни погашенной кнопки, ни слова. При пятистах одновременных
   * сдачах на нагруженной сети человек жмёт снова и снова, и каждое нажатие —
   * ещё один `council:submit`. Признак местный и честный: он говорит
   * «отправлено», а не «сдано», и снимается ЛИБО эхом, либо своим сроком —
   * молчания на восемь секунд не бывает без причины, и о ней надо сказать
   * словами.
   */
  let awaitingMine = $state<'submit' | 'withdraw' | null>(null)
  let awaitTimer: number | undefined
  const MINE_WAIT_MS = 8000

  function awaitMine(what: 'submit' | 'withdraw'): void {
    window.clearTimeout(awaitTimer)
    awaitingMine = what
    awaitTimer = window.setTimeout(() => {
      awaitingMine = null
      session.showError(
        what === 'submit'
          ? tr('room.ui.407')
          : tr('room.ui.408'),
      )
    }, MINE_WAIT_MS)
  }

  $effect(() => {
    const now = submittedAt
    const want = untrack(() => awaitingMine)
    if (want === null) return
    if (want === 'submit' ? now === null : now !== null) return
    awaitingMine = null
    window.clearTimeout(awaitTimer)
  })

  $effect(() => () => window.clearTimeout(awaitTimer))

  /** «Сдать». Возвращает, дошло ли до отправки, — для клавиш. */
  function submitAttempt(): boolean {
    if (!mayAttempt) {
      session.showError(attemptWhy + '.')
      return false
    }
    // Второе нажатие, пока первое в пути, — это второй `council:submit`, и
    // ровно его и жмут, когда «ничего не произошло».
    if (awaitingMine !== null || submittedAt !== null) return false
    /*
     * Сдать то, чего у сервера нет, нельзя.
     *
     * Сверх потолка снимок не уезжает, а `council:submit` сдаёт ТО, ЧТО ЛЕЖИТ
     * У СЕРВЕРА: нажатие пометило бы сданным прошлый, короткий текст — у
     * студента на экране один лист, у преподавателя в стопке другой, и
     * выясняется это на разборе, когда переписывать поздно. Отказ словами и с
     * числом: из него видно, сколько резать.
     */
    if (attemptOver) {
      session.showError(
        tr('room.ui.409', { p0: attemptCount ?? '' }),
      )
      return false
    }
    onselect()
    awaitMine('submit')
    session.council.submit(id)
    return true
  }

  function withdrawAttempt(): void {
    if (!mayAttempt) {
      session.showError(attemptWhy + '.')
      return
    }
    if (awaitingMine !== null || submittedAt === null) return
    awaitMine('withdraw')
    session.council.withdraw(id)
  }

  /** Запустить свою попытку — только при включённой ручке; отказ словами. */
  function runAttempt(): void {
    if (councilClosed || attemptRunning || attemptOver || !session.connected) return
    if (!mayRunAttempt) {
      session.showError(
        may.finished
          ? tr(CLASS_IS_OVER) + '.'
          : councilSettings.studentRun === 'request'
            ? tr('room.ui.410')
            : tr('room.ui.411'),
      )
      return
    }
    session.council.run(id)
  }

  let requestSending = $state<{ action: 'request' | 'cancel'; previousId: string | null; text: string } | null>(null)
  let requestTimer: number | undefined

  function awaitRequest(action: 'request' | 'cancel'): void {
    window.clearTimeout(requestTimer)
    requestSending = { action, previousId: mine?.runRequest?.id ?? null, text: sheetText }
    requestTimer = window.setTimeout(() => {
      requestSending = null
      session.showError(tr('room.ui.412'))
    }, MINE_WAIT_MS)
  }

  $effect(() => {
    const request = mine?.runRequest
    const text = mine?.text
    const closed = councilClosed || councilSettings.studentRun !== 'request'
    const sending = untrack(() => requestSending)
    if (!sending) return
    const confirmed = sending.action === 'cancel'
      ? request?.id !== sending.previousId || request?.status !== 'pending'
      : request?.status === 'pending' && request.id !== sending.previousId && text === sending.text
    if (!closed && !confirmed) return
    requestSending = null
    window.clearTimeout(requestTimer)
  })
  $effect(() => () => window.clearTimeout(requestTimer))

  function requestAttemptRun(): void {
    if (!mayRequestRun || attemptRunning || attemptOver || requestSending || !session.connected || !sheetText.trim()) return
    if (mine?.runRequest?.status === 'pending' && attemptSynced) return
    // В том числе нетронутое условие: его ещё могло не быть среди попыток.
    if (!attemptSynced) session.council.draft(id, sheetText)
    awaitRequest('request')
    session.council.requestRun(id)
  }

  function cancelAttemptRunRequest(): void {
    const request = mine?.runRequest
    if (!mayRequestRun || requestSending || !session.connected || request?.status !== 'pending') return
    awaitRequest('cancel')
    session.council.cancelRunRequest(id, request.id)
  }

  /* ---- лист: состояние словом, заготовка под рукой и клавиши */

  /**
   * Заготовка преподавателя — то, с чего лист начинался.
   *
   * Та же пара, что у `sheetSeed`: `mine.seed` (общий текст на момент, когда
   * замок перевели в консилиум) главнее нынешнего общего текста, потому что
   * после «Показать классу» в общем лежит уже чьё-то решение. Старый сервер
   * поля не шлёт — тогда остаётся общий текст, как и при засеве листа.
   */
  /*
   * Функцией, а не руной: `liveText` объявлен ниже по файлу (он про ОБЩИЙ
   * текст ячейки и живёт среди прочего её хозяйства), а руна, читающая его
   * отсюда, была бы обращением к переменной до объявления. Тело функции
   * выполняется при чтении — то есть уже после, — и зависимости считаются
   * там же, где читаются.
   */
  function stubText(): string {
    return mine?.seed ?? liveText.current
  }

  /**
   * Состояние листа ОДНИМ словом: чип в подвале и цвет полосы слева.
   *
   * Порядок — по тому, что человеку делать дальше. «Есть правки» впереди
   * отметки: у преподавателя лежит не то, что на экране, и пока это так,
   * любая отметка относится к прошлому тексту. Отметку до сегодня автор не
   * видел вовсе: преподаватель ставил её в стопке, она доезжала в
   * `council:mine` и умирала в нём.
   */
  const sheetState = $derived(
    (submittedAt !== null && !attemptSynced) || (submittedAt === null && mine?.correct != null)
      ? 'edited'
      : submittedAt === null
        ? 'draft'
        : mine?.correct === true
          ? 'correct'
          : mine?.correct === false
            ? 'wrong'
            : 'submitted',
  )
  /**
   * Разобрано — когда? Своего времени у отметки в протоколе нет
   * (`CouncilMine.correct` — голый признак), и придумывать его ради подписи
   * значило бы менять кадр под оформление. Поэтому берётся время последнего
   * письма: разбор и письмо пишутся в одну минуту, а если письма нет —
   * подпись говорит «разобрано» без часов, и это правда.
   */
  const reviewedAt = $derived(letters.length > 0 ? letters[letters.length - 1].at : null)

  /**
   * Вывод попытки, стёртый возвратом к заготовке.
   *
   * Стереть его у сервера нечем: кадра «забудь этот запуск» в `council:*` нет,
   * а заводить его ради одной кнопки — менять протокол под оформление. Поэтому
   * помним МОМЕНТ СТАРТА того запуска, чей вывод человек убрал вместе с
   * текстом: следующий запуск придёт со своим `startedAt` и нарисуется сам.
   */
  let clearedRunAt = $state<number | null>(null)
  const attemptRun = $derived(
    mine?.run && mine.run.startedAt !== clearedRunAt ? mine.run : null,
  )

  /**
   * «Восстановить» — вернуть лист к заготовке.
   *
   * Стёртый каркас переставал существовать: спросить его было не у кого, и
   * преподаватель диктовал вслух. Нельзя у сданного (сданное правят после
   * «Изменить») и нельзя, когда лист уже равен заготовке, — возвращать нечего.
   */
  const mayRestore = $derived(mayAttempt && submittedAt === null && sheetText !== stubText())

  /**
   * Запуск и запрос — одна кнопка, потому что для студента это одно движение.
   *
   * Ручка `studentRun` — правило ПРЕПОДАВАТЕЛЯ о том, чья очередь: сам или с
   * разрешения. Студенту она объясняла себя тремя лишними словами
   * («Попросить запуск», «Запрошено 14:31», «Отправляю запрос…»), то есть
   * заставляла его знать про механику, которой он не управляет. Нажатие одно
   * — «Запустить», — а дальше в обоих случаях ждут: в одном ядра, в другом
   * преподавателя и ядра. Ожидание и называется одинаково.
   */
  const mayPressRun = $derived(
    councilSettings.studentRun === 'request'
      ? mayRequestRun && sheetText.trim() !== '' && requestSending === null
      : mayRunAttempt,
  )
  /** Запрос лежит у преподавателя и относится к тому тексту, что на экране. */
  const requestPending = $derived(
    councilSettings.studentRun === 'request' &&
      attemptSynced &&
      mine?.runRequest?.status === 'pending',
  )
  /**
   * Нажатие уже сделано и ждёт — очереди ядра или преподавателя.
   *
   * `requestSending` здесь же: между нажатием и эхом сервера кнопка обязана
   * быть погашенной, иначе на плохой сети её жмут второй раз.
   */
  const runWaiting = $derived(
    mine?.queue != null ||
      attemptRunning ||
      requestPending ||
      requestSending?.action === 'request',
  )
  /**
   * Отменить можно ЗАПРОС, и только его: очередь ядра отменять нечем —
   * `council:run:cancel` снимает запрос (server/src/control.ts · resolveRunRequest),
   * а кадра «убрать из очереди» в протоколе нет. Ссылку рядом с «В очереди»
   * рисуем поэтому только там, где ей есть что сделать.
   */
  const mayCancelRun = $derived(requestPending && mayRequestRun)

  /**
   * «Подсказка оракула» — по СВОЕЙ упавшей попытке и только по ней.
   *
   * Кнопка появляется ровно тогда, когда есть о чём спрашивать: запуск кончился
   * ошибкой. Без трейсбека вопрос выродился бы в «посмотри мой код и скажи,
   * верно ли» — то есть в решение за студента, от которого консилиум и
   * защищают.
   *
   * Путь у неё свой, не `/ai/ask`: тот пишет вопрос и ответ в общую ленту, а
   * тексты консилиума частные. Ответ приходит письмом в саму попытку
   * (`council:hint` в control.ts), и виден он тем же двоим, что видят её текст.
   */
  const hint = $derived(session.council.hints[id] ?? null)
  const mayHint = $derived(
    !councilClosed && mine?.run?.state === 'error' && mayAttempt && session.connected,
  )
  /** Вопрос «вернуть?» — на месте кнопки, без окна браузера. */
  let restoreAsking = $state(false)
  /**
   * Ширина подвала — чтобы чип ужимался раньше, чем строка переносится.
   *
   * Подвал живёт в колонке тетради, а её ширину решают боковые панели, а не
   * окно: на 636 px с обеими открытыми панелями «СДАНО 14:32 · ЖДЁТ РАЗБОРА»
   * вместе с двумя кнопками не помещалось, и вниз уезжали кнопки — то есть
   * главное. Медиазапросу этого не видно, поэтому меряется сам элемент.
   */
  let footerWidth = $state(0)
  /** Ноль — ещё не мерили: до первого замера чип полный, а не урезанный. */
  const tightFooter = $derived(footerWidth > 0 && footerWidth < 460)
  $effect(() => {
    if (!mayRestore) restoreAsking = false
  })

  function restoreStub(): void {
    const current = untrack(() => sheet)
    restoreAsking = false
    if (!current || !mayRestore) return
    /*
     * Происхождение обычное (null), а не SEED, и это несущее решение: снимок
     * обязан уехать на сервер как всякий набор — иначе у преподавателя
     * остался бы стёртый текст, — а сам возврат обязан лечь в отмену, чтобы
     * Cmd+Z вернул написанное. SEED делает ровно наоборот: не уезжает и не
     * отменяется.
     */
    clearedRunAt = untrack(() => mine?.run?.startedAt ?? null)
    current.doc.transact(() => replaceText(current.text, stubText()))
  }

  /**
   * «Сдать заново»: у преподавателя лежит не то, что человек видит на листе.
   *
   * `submitAttempt` сюда не годится — он нарочно не пускает второе нажатие по
   * уже сданному листу (иначе на плохой сети это пятьсот `council:submit`
   * подряд). А здесь второе нажатие и есть смысл: дослать снимок и сдать ещё
   * раз. Чип вернётся к «Сдано» тем же эхом, каким разошёлся.
   */
  function resubmitAttempt(): void {
    if (!mayAttempt) {
      session.showError(attemptWhy + '.')
      return
    }
    if (attemptOver) {
      session.showError(tr('room.ui.409', { p0: attemptCount ?? '' }))
      return
    }
    session.council.draft(id, sheetText)
    // Снятая попытка сдаётся заново по-настоящему (сервер поставит время), и
    // тогда ждём эха, как обычная сдача. Сданной сервер время не переносит —
    // ждать нечего, чип вернётся к «Сдано», как только доедет свежий снимок.
    if (submittedAt === null) awaitMine('submit')
    session.council.submit(id)
  }

  /**
   * ⇧↵ на своём листе СЧИТАЕТ, а не сдаёт.
   *
   * Сдавало: запуска у студента не было вовсе, и пальцам, привыкшим к
   * «выполнить и дальше», надо было куда-то попадать. Запуск появился — и с
   * ним вернулась обычная мерка тетради: ⇧↵ считает, ⌘↵ считает не уходя,
   * сдаёт одно ⌘⇧↵. При выключенной ручке клавиша не ругается и ничего не
   * сдаёт: говорит словами, кто здесь запускает, и гаснет через две секунды.
   * Тост тут был бы не к месту — это не отказ, а правило ячейки.
   */
  let runHint = $state(false)
  let runHintTimer: number | undefined
  const RUN_HINT_MS = 2000

  function sheetRunKey(): void {
    if (councilSettings.studentRun === 'request' && mayRequestRun) {
      requestAttemptRun()
      return
    }
    if (mayRunAttempt) {
      runAttempt()
      return
    }
    window.clearTimeout(runHintTimer)
    runHint = true
    runHintTimer = window.setTimeout(() => (runHint = false), RUN_HINT_MS)
  }

  $effect(() => () => window.clearTimeout(runHintTimer))

  /**
   * Сдача с клавиатуры — и мигание кнопки в ответ.
   *
   * Сочетание неудобное нарочно, а неудобное нажатие должно быть видно: без
   * вспышки ⌘⇧↵ неотличимо от промаха по ⌘↵, потому что «сдано» приезжает
   * эхом сервера и не мгновенно.
   */
  let submitFlash = $state(false)
  let flashTimer: number | undefined
  const FLASH_MS = 260

  function submitFromKey(): void {
    window.clearTimeout(flashTimer)
    submitFlash = true
    flashTimer = window.setTimeout(() => (submitFlash = false), FLASH_MS)
    if (sheetState === 'edited') resubmitAttempt()
    else void submitAttempt()
  }

  $effect(() => () => window.clearTimeout(flashTimer))

  /* ---- пульт преподавателя: колбэки для стопки и сводки */

  function showToClass(participantId: string): void {
    const who = board?.attempts.find((attempt) => attempt.participantId === participantId)
    // Подтверждение — потому что это единственное действие консилиума, которое
    // меняет общую ячейку у всей комнаты, и назад его не отматывают.
    if (
      !window.confirm(
        who ? tr('room.confirm.showNamed', { name: who.name }) : tr('room.confirm.showAnswer'),
      )
    ) {
      return
    }
    session.council.show(id, participantId)
  }

  function runAttemptOf(participantId: string): void {
    session.council.run(id, participantId)
  }

  function replyTo(to: { participantId: string } | { groupKey: string }, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    session.council.reply(id, to, trimmed)
  }

  function markAttempt(participantId: string, correct: boolean | null): void {
    session.council.mark(id, participantId, correct)
  }

  /**
   * Спросить оракула о решениях — или остановить чтение.
   *
   * По HTTP, а не сокетом: у отказа есть цена (вопрос из лимита комнаты) и
   * срок (429 с `retryAfter`), и говорить о них умеет `ApiError`. Готовая
   * сводка приедет сокетом (`council:oracle`) вместе со стопкой.
   */
  async function askOracle(stop: boolean): Promise<void> {
    try {
      if (stop) await api.councilStopOracle(session.session.id, session.token, id)
      else await api.councilAsk(session.session.id, session.token, id)
    } catch (cause) {
      session.showError(cause instanceof Error ? tr(cause.message) : tr('room.ui.414'))
    }
  }

  /**
   * Какая попытка на карточке стопки. Состояние экрана, не комнаты: два
   * преподавателя листают одну стопку каждый со своего места, и второй
   * планшет не должен перелистывать первый.
   */
  let stackPosition = $state<{ participantId: string | null }>({ participantId: null })

  /* ---- замок в три положения */

  /**
   * Меню замка: три положения и две ручки консилиума.
   *
   * Щелчок остаётся щелчком — закрыта ↔ открыта, без меню и без диалога, по
   * доводу из разметки замка. Куда именно открывает щелчок, решает правило
   * комнаты `opens` — общий текст или каждому свой лист, — и то же правило
   * читают подсказки и второе нажатие (lib/lock-button.ts). Меню открывают
   * удержанием, правой кнопкой или щелчком по замку в положении, куда щелчком
   * не попадали: там одно нажатие не знает, куда вернуть.
   */
  let lockMenu = $state(false)

  /* ------------------------------------------- пульт консилиума в окне */

  /**
   * Пульт консилиума открыт в отдельном окне — и пока он открыт, приватная
   * консоль ПОД ЯЧЕЙКОЙ НЕ РИСУЕТСЯ.
   *
   * Это и есть починка утечки, ради которой окно заводили: тетрадь зеркалится
   * в зал, и два места с одними и теми же именами, черновиками и отметками —
   * источник того, что зал видит чужие фамилии. Одно место за раз.
   *
   * Узнаём стуком по BroadcastChannel (lib/council-pult-window.ts), а не по
   * ссылке на окно: ссылку теряет перезагрузка тетради, а окно при этом живо.
   * Молчание дольше трёх секунд — закрыто: отсутствие вести о смерти не должно
   * прятать консоль навсегда.
   */
  let pultBeat = $state.raw<PultBeat | null>(null)
  let pultNow = $state(Date.now())
  /** Ссылка на окно, если открывали из этой вкладки, — чтобы поднять его. */
  let pultWindow: Window | null = null
  const pultOpen = $derived(
    leads && inCouncil && pultBeat?.cellId === id && beatsAlive(pultBeat, pultNow),
  )

  $effect(() => {
    if (!leads || !inCouncil) return
    const stop = watchPult(session.session.id, (beat) => {
      pultBeat = beat
      pultNow = Date.now()
    })
    // Своё затухание: сообщений больше нет, а «открыт» обязан погаснуть сам.
    const timer = setInterval(() => (pultNow = Date.now()), 1000)
    return () => {
      stop()
      clearInterval(timer)
    }
  })

  function openCouncilPult(): void {
    lockMenu = false
    pultWindow = openPult(session.session.id, id)
  }

  /** Поднять уже открытое окно; ссылки нет (перезагрузили тетрадь) — открыть заново. */
  function raiseCouncilPult(): void {
    if (pultWindow && !pultWindow.closed) {
      pultWindow.focus()
      return
    }
    pultWindow = openPult(session.session.id, id)
  }

  let holdTimer: number | undefined
  /**
   * Когда удержание открыло меню: щелчок, который приходит вслед за отпусканием,
   * не в счёт. Метка времени, а не флаг: на сенсорном экране щелчка после
   * долгого нажатия может и не быть, и флаг съел бы следующее честное нажатие.
   */
  let heldAt = 0
  const HOLD_MS = 450

  const LOCKS: { state: CellLock; icon: IconName; label: string; hint: string }[] = [
    { state: 'closed', icon: 'lock', label: tr('room.ui.415'), hint: tr('room.ui.416') },
    { state: 'open', icon: 'unlock', label: tr('room.ui.417'), hint: tr('room.ui.418') },
    { state: 'council', icon: 'users', label: tr('room.ui.34'), hint: tr('room.ui.419') },
  ]
  const lockIcon = $derived<IconName>(inCouncil ? 'users' : cellOpen ? 'unlock' : 'lock')
  // Правило комнаты, а не положение ячейки: что значит «открыть» здесь.
  const opens = $derived(may.rules.opens)

  /*
   * Нажатие услышано — местным признаком, пока не вернулся кадр.
   *
   * Замок ничего не предугадывает: значок меняется тогда же, когда меняется у
   * всей комнаты, и это правильно. Но на ретрансляторе кадр идёт 100–300 мс, и
   * в них преподаватель посреди фразы не видел РОВНО НИЧЕГО — жал второй раз и
   * возвращал замок обратно. Признак не врёт о положении: он говорит только
   * «отправлено», гаснет от любого пришедшего кадра и от собственного срока —
   * сеть может и не ответить, а висеть до конца пары ему нельзя.
   */
  let lockSending = $state(false)
  /** Обычные `let`: их читает только код, зависеть от них эффекту незачем. */
  let sentFrom: CellLock | null = null
  let sentTimer: number | undefined
  const SENT_MS = 2000

  function markSending(): void {
    window.clearTimeout(sentTimer)
    sentFrom = lockState
    lockSending = true
    sentTimer = window.setTimeout(() => {
      sentFrom = null
      lockSending = false
    }, SENT_MS)
  }

  $effect(() => {
    const now = lockState
    if (sentFrom === null || now === sentFrom) return
    sentFrom = null
    window.clearTimeout(sentTimer)
    lockSending = false
  })

  $effect(() => () => window.clearTimeout(sentTimer))

  function pressLock(): void {
    if (Date.now() - heldAt < HOLD_MS * 2) return
    const press = lockPress(lockState, opens)
    if (press.kind === 'menu') {
      lockMenu = !lockMenu
      return
    }
    // Два положения — прежним сообщением: сервер читает его как cell:lock и
    // сам решает по правилу комнаты, общий это текст или консилиум.
    markSending()
    session.send({ t: 'cell:open', cellId: id, open: press.open })
  }

  function startHold(): void {
    window.clearTimeout(holdTimer)
    holdTimer = window.setTimeout(() => {
      heldAt = Date.now()
      lockMenu = true
    }, HOLD_MS)
  }

  function endHold(): void {
    window.clearTimeout(holdTimer)
  }

  function setLock(state: CellLock): void {
    lockMenu = false
    if (state === lockState) return
    markSending()
    session.council.lock(id, state)
  }

  function setStudentRun(studentRun: CouncilSettings['studentRun']): void {
    if (!inCouncil || !session.connected || studentRun === councilSettings.studentRun) return
    session.council.lock(id, 'council', { studentRun })
  }

  /**
   * Имена на проекторе — ручка, у которой снова есть исполнение.
   *
   * Её убирали из этого меню как обещание без исполнения: поле писалось в
   * документ и не читалось ничем. Теперь его читает сервер, когда собирает
   * подпись показанной попытки (shared/protocol.ts · CouncilShown): выключенная
   * — и ни имени, ни цвета, ни аватара нет ни в одном кадре, а подписывает
   * «Вариант N» — одинаково в тетради у всех, в плашке преподавателя и на
   * проекторе.
   */
  function setNamesOnProjector(namesOnProjector: boolean): void {
    if (!inCouncil || !session.connected) return
    if (namesOnProjector === councilSettings.namesOnProjector) return
    session.council.lock(id, 'council', { namesOnProjector })
  }

  // Меню закрывается снаружи: щелчок мимо, Escape, потеря замка.
  $effect(() => {
    if (!lockMenu) return
    const away = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && root?.querySelector('[data-lock-menu]')?.contains(target)) return
      if (target && root?.querySelector('[data-lock-button]')?.contains(target)) return
      lockMenu = false
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') lockMenu = false
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', escape, true)
      window.clearTimeout(holdTimer)
    }
  })

  /*
   * Ячейка спрятала замок (правила сменились, звонок) — меню ей ни к чему.
   * `lock` здесь читается, `lockMenu` пишется: круга нет.
   */
  $effect(() => {
    if (!lock || may.role !== 'host') lockMenu = false
  })

  /** Показать черновик закрытого консилиума — свёрнут по умолчанию. */
  let showDraft = $state(false)

  /*
   * Ячейка остановилась внутри input().
   *
   * Это единственное состояние, в котором ядро ждёт ЧЕЛОВЕКА, а не машину.
   * Что ячейка ждёт ответа, видит вся комната — приглашение ко вводу живёт в
   * документе. А отвечает тот, чья ячейка спрашивает, или преподаватель: так
   * решает сервер (`control.ts`, case 'input', тем же `startedTheRunningCell`,
   * что и «остановить»), и `input()` под паролем — как раз про то, почему
   * видеть и отвечать не одно и то же.
   *
   * Поле и фокус идут за этим правом. Пока не шли, подпись звала отвечать всю
   * комнату, курсор выпрыгивал из чужой ячейки в каждом браузере, а набранный
   * ответ стирался вместе с отказом сервера.
   */
  const stdin = $derived(meta.current.stdin)
  let answer = $state('')
  let answerField = $state<HTMLInputElement | null>(null)

  /*
   * Фокус — только тому, ЧЬЯ ячейка спрашивает.
   *
   * `canAnswer` у преподавателя истинно на ЛЮБОЙ ячейке, так что в
   * лаборатории с `run: room` каждый `input()` любого студента вырывал у него
   * курсор из ячейки, в которой он печатает, и — фокусом без `preventScroll` —
   * уносил экран к чужой ячейке двумя сотнями строк ниже. Поле ему по-прежнему
   * рисуют: ответить он вправе, — но приходит к нему он сам.
   *
   * `preventScroll` и отдельный `scrollIntoView` — не одно и то же с обычным
   * `focus()`: браузер прокручивает к полю ЛЮБОЙ предок, в том числе
   * горизонтально, а здесь нужно ровно «подвести ячейку, если её не видно».
   */
  $effect(() => {
    if (stdin && canAnswer && mineIsRunning) {
      answerField?.focus({ preventScroll: true })
      root?.scrollIntoView({ block: 'nearest' })
    } else if (!stdin) answer = ''
  })

  function sendAnswer(event: SubmitEvent): void {
    event.preventDefault()
    if (!stdin) return
    session.send({ t: 'input', value: answer, cellId: id })
    // Поле чистит эффект выше, когда ядро перестало ждать. Стереть здесь
    // значило бы потерять набранное вместе с любым отказом.
  }
  const cellState = $derived(meta.current.state)

  /*
   * Мгновенная ячейка не мигает.
   *
   * `print(1)` проходит очередь и выполнение за десятки миллисекунд, и на этих
   * десятках миллисекунд интерфейс успевал показать всё: полоса вспыхивала
   * акцентом, номер менял цвет, снизу появлялась и пропадала строка состояния,
   * кнопка в тулбаре оборачивалась в квадрат и обратно. Получалось моргание на
   * ровном месте — и тем заметнее, чем быстрее ячейка.
   *
   * Поэтому состояние занятости показывают не сразу: если выполнение кончилось
   * раньше порога, показывать было нечего и никто ничего не увидел. Если оно
   * живёт дольше — всё появляется разом, и появляется уже надолго.
   *
   * Порог местный и в документ не попадает: это про то, как рисуют, а не про
   * то, что происходит. Двести миллисекунд — обычная граница, за которой
   * человек начинает замечать ожидание; ниже неё указатель успевает только
   * мигнуть.
   */
  const BUSY_VISIBLE_MS = 200
  const busy = $derived(cellState === 'running' || cellState === 'queued')
  let showBusy = $state(false)
  $effect(() => {
    if (!busy) {
      showBusy = false
      return
    }
    const id = window.setTimeout(() => (showBusy = true), BUSY_VISIBLE_MS)
    return () => window.clearTimeout(id)
  })

  /**
   * Состояние, каким его рисуют, — против того, каким оно есть.
   *
   * Отличаются они только в те двести миллисекунд, пока занятость ещё не
   * показывают. Решения принимаются по настоящему `cellState` (см. `run`),
   * рисуется — по этому.
   */
  const shownState = $derived(busy && !showBusy ? 'idle' : cellState)
  const running = $derived(cellState === 'running')
  /** То же для разметки: полоса, строка состояния и лицо кнопки ждут порога. */
  const shownRunning = $derived(running && showBusy)

  let editing = $state(false)
  /** Only true when edit mode was entered deliberately, so a peer cannot steal focus. */
  let focusOnEdit = $state(false)
  let focusWithin = $state(false)

  const showEditor = $derived(isCode || editing)

  const outputs = watchOutputs(() => cell.current)
  const peersHere = watchCellPeers(session.awareness, () => id)
  const notebook = watchNotebookMeta(session.doc)

  const ytext = $derived(cell.current ? cellSource(cell.current) : null)

  /**
   * Текст ячейки в буфер — для тех, кому копию в тетрадь не дают.
   *
   * Слот «Создать копию» в тулбаре у участника лекции и консилиума был просто
   * погашен: правило структуры не пускает, а унести код к себе всё равно надо.
   * Отказ буфера (настройка браузера) молчит: текст остаётся выделяемым.
   */
  let copied = $state(false)
  let copiedTimer: number | undefined
  async function copySource(): Promise<void> {
    try {
      await copyText(ytext?.toString() ?? '')
      copied = true
      window.clearTimeout(copiedTimer)
      copiedTimer = window.setTimeout(() => (copied = false), NOTICED_MS)
    } catch {
      // см. выше
    }
  }
  $effect(() => () => window.clearTimeout(copiedTimer))
  const queuePosition = $derived(notebook.current.queue.indexOf(id))
  const hasError = $derived(
    cellState === 'error' || outputs.current.some((output) => output.kind === 'error'),
  )

  /** 01, 02, 03 — the ordinal the artboard leads the gutter with. */
  const ordinal = $derived(String(index + 1).padStart(2, '0'))

  /*
   * One signal, two marks: the ordinal in the gutter and the rule down the left
   * edge of the body. Running and error outrank selection deliberately — a cell
   * you have clicked on is still, first, a cell that failed.
   */
  /*
   * Открытая ячейка стоит ВЫШЕ выделенной по той же причине, по какой выше неё
   * стоят работающая и упавшая: это факт о комнате, а не о твоём курсоре. Ради
   * него полосу и красят — «открыта» должно читаться из середины аудитории, а
   * не при разглядывании; выделение при этом остаётся помеченным номером, как и
   * на работающей ячейке.
   */
  const tone = $derived(
    shownRunning
      ? 'running'
      : hasError
        ? 'error'
        : shownState === 'queued'
          ? 'queued'
          : lock && (cellOpen || inCouncil)
            ? 'open'
            : selected
              ? 'selected'
              : 'idle',
  )

  /*
   * A resting cell has nothing to announce, so the ordinal is quiet — but it is
   * also how the room refers to a cell out loud ("look at four"), so quiet has a
   * floor. faint/70 measured 2.1:1 on the dark ground, which is not quiet, it is
   * gone; and the error ordinal at danger/50 was the dimmest thing on the one
   * cell everybody is looking at.
   */
  const ORDINAL = {
    running: 'text-accent-text',
    error: 'text-danger',
    queued: 'text-accent-text/80',
    open: 'text-accent-text',
    selected: 'text-ink',
    idle: 'text-muted',
  } as const

  /*
   * Вертикальная полоса слева от тела ячейки — единственный признак состояния,
   * который есть у ЛЮБОЙ ячейки: и у кода, и у прочитанного текста, и у
   * свёрнутой. Поэтому выбор говорит именно ей.
   *
   * Выбранная — цветом чернил, то есть самым тёмным, что есть на листе: она
   * должна отличаться от покоящейся (тонкая серая линия) на расстоянии
   * проектора, а не при разглядывании.
   */
  const RULE = {
    /*
     * Работающая — приглушённая, и это не описка: поверх неё лежит дышащая
     * полоса той же ширины и на том же месте (см. разметку ниже). Пара даёт
     * линию, которая ходит между полным акцентом и 55 % — ярче всех на листе
     * в верхней точке и близко к очереди в нижней. Различает их не яркость, а
     * то, что одна движется: ядро выполняет по одной ячейке, так что в тетради
     * движется ровно одна вещь.
     *
     * Врозь эти два значения бессмысленны: без полосы работающая ячейка станет
     * бледнее стоящей в очереди. Менять их можно только вместе.
     */
    running: 'border-accent/40',
    error: 'border-danger',
    queued: 'border-accent/50',
    /*
     * Открытая — полным акцентом и без дышащей полосы поверх: она не работает,
     * она разрешена. Это единственное спокойное состояние, которому дан цвет, и
     * дан он ровно затем, чтобы в закрытой тетради нашлась глазом одна ячейка.
     */
    open: 'border-accent',
    selected: 'border-ink',
    idle: 'border-line',
  } as const

  /*
   * Whose run this is only matters when it tells you something you did not
   * already know: that a cell is busy, or that a finished result came from
   * somebody else's keyboard.
   */
  const runBy = $derived(meta.current.runBy)
  /*
   * Stopping your own runaway loop should not require a teacher in the room.
   * The server decides this too, from its own record of the queue — this only
   * decides whether the control is drawn as usable.
   */
  const mineIsRunning = $derived(meta.current.runById === session.me.id)
  const canInterrupt = $derived(session.me.role === 'host' || mineIsRunning)
  /*
   * Ответить в input() — тот же круг людей и та же серверная проверка, что у
   * «остановить». Отдельным именем, потому что это другой вопрос к комнате: не
   * «чью работу ты прерываешь», а «чья ячейка спрашивает».
   *
   * И конец занятия: правилом это не выражается — правил про `input()` нет, —
   * поэтому здесь та же `actsAfterClass`, которой отвечает сервер. Случай
   * редкий и настоящий: занятие заканчивают, пока чья-то ячейка стоит в
   * ожидании ввода, и поле, которому сервер откажет, лучше не рисовать.
   */
  const canAnswer = $derived(canInterrupt && acts)
  /*
   * A queued cell can be taken back; the running one cannot, that is Interrupt.
   * It matters most in the case the control is for: somebody else's long cell
   * holds the kernel, you pressed Run All behind it, and Interrupt is not yours
   * to press. The server checks this again against its own queue.
   */
  const canCancel = $derived(session.me.role === 'host' || meta.current.runById === session.me.id)
  /*
   * Два одинаковых по виду выражения не сливаются в одно намеренно: сервер
   * отвечает на них из разных записей — на «остановить» из среды исполнения,
   * на «убрать из очереди» из очереди, — и совпадают они по сегодняшнему
   * правилу, а не по устройству.
   */

  /*
   * Первое место в тулбаре: запуск, отмена или стоп — смотря что делает ячейка.
   *
   * Раньше здесь всегда была кнопка запуска, и на работающей ячейке она была
   * включена и не делала ничего: `requestRun` на сервере пропускает и то, что
   * уже выполняется, и то, что уже в очереди. Решение вынесено в отдельный
   * модуль — там же оно и проверяется тестами.
   */
  /*
   * Тик секундомера — здесь, а не в документе.
   *
   * Пятая доля секунды, а не целая: десятая доля — это и есть та цифра, по
   * которой видно, работает ячейка или висит. Интервал заводится только на
   * время выполнения и снимается в уборке, так что при выключенном ядре в
   * тетради не тикает ничего.
   *
   * Ядро выполняет по одной ячейке, поэтому во всей вкладке живёт не больше
   * одного такого интервала — сколько бы ячеек в тетради ни было, и без
   * какого-либо согласования между ними: эффект смотрит на `running` своей
   * ячейки, и этого достаточно.
   */
  let now = $state(Date.now())
  $effect(() => {
    if (!running) return
    const id = window.setInterval(() => (now = Date.now()), 200)
    return () => window.clearInterval(id)
  })

  /* ------------------------------------------------- место под вывод */

  /** Сколько область намерила собой сейчас; пишется на внутренний узел. */
  let outputsMeasured = $state(0)
  /** Сколько она занимала, когда в ней последний раз что-то было, и чем это было. */
  let heldOutput = $state<Held>(NO_HELD)
  /** Сколько картинок ещё не сообщили свой размер; приходит из CellOutputs. */
  let outputsPending = $state(0)

  const outputFloor = $derived(
    outputSeat({
      running,
      outputs: outputs.current.length,
      pendingImages: outputsPending,
      held: heldOutput,
    }),
  )

  const unnumbered = $derived(
    isCode &&
      unnumberedResult({
        state: cellState,
        execCount: meta.current.execCount,
        outputs: outputs.current.length,
      }),
  )

  // Запоминание высоты. Обе проверки внутри nextHeld несущие — см. модуль.
  /*
   * Запоминание высоты — и две ловушки Svelte, в которые я уже попал.
   *
   * Эффект читает прошлое значение и пишет новое, а `nextHeld` возвращает
   * ОБЪЕКТ. Значит, даже когда ничего не изменилось, присваивается новая
   * ссылка — эффект зависит от того, что сам же и пишет, и перезапускается
   * вечно. Svelte это ловит и валит всё приложение целиком:
   * effect_update_depth_exceeded, тетрадь перестаёт рисоваться, ячейки
   * двоятся. Первый раз это прошло незамеченным ровно потому, что раньше
   * функция возвращала число, и 900 === 900 останавливало круг само.
   *
   * Поэтому: прошлое значение читается через untrack — эффект зависит только
   * от входов, — и присваивание происходит, лишь когда что-то правда стало
   * другим. Любой из этих двух приёмов закрывает дыру; здесь стоят оба,
   * потому что цена ошибки — не «чуть дёргается», а «приложение не работает».
   */
  $effect(() => {
    const input = {
      running,
      outputs: outputs.current.length,
      pendingImages: outputsPending,
      measured: outputsMeasured,
      hasError,
    }
    const previous = untrack(() => heldOutput)
    const next = nextHeld(previous, input)
    if (next.px !== previous.px || next.fromError !== previous.fromError) heldOutput = next
  })

  const slot = $derived(
    runSlot(shownState, {
      connected: session.connected,
      mayRun,
      canCancel,
      canInterrupt,
    }),
  )
  /**
   * Метка выполнения в поле — `[ ]`, `[7]`, `[*]`, `[—]`. См. lib/output-seat.
   *
   * Одна колонка под номером отвечает на «запускалась ли она», и отвечает у
   * всякой ячейки, а не только у той, что что-то напечатала.
   */
  const mark = $derived(
    runMark({
      type: meta.current.type,
      state: shownState,
      execCount: meta.current.execCount,
      outputs: outputs.current.length,
      running: shownRunning,
    }),
  )
  /*
   * Цвет метки — тот же язык, что у полосы и номера: акцент у идущей, красный
   * у упавшей, охра у той, чей номер потеряли. Спокойная метка приглушена и не
   * спорит с номером ячейки, который на полтора размера крупнее.
   */
  const MARK = {
    /*
     * Пустые скобки и скобки с числом — одного тона, и это решение, а не
     * недосмотр: приглушить «не считалась» значило бы сделать тихим ровно тот
     * случай, ради которого метку и завели. Так же у Jupyter — различает их
     * содержимое, а не яркость.
     */
    idle: 'text-muted',
    busy: 'text-accent-text',
    done: 'text-muted',
    error: 'text-danger',
    lost: 'text-warning',
  } as const

  /*
   * «Чужая» и «чьё лицо» — по имени участника, а не по его имени собственному.
   *
   * Имена в комнате не уникальны, и сервер это знает: двое «Анна» — два
   * человека. Пока сравнивали строкой, второй Анне под её же ячейкой не
   * рисовали «Ran by Анна», а под бегущей висел аватар той Анны, которая
   * раньше попала в `session.peers`. Имя остаётся тем, что ЧИТАЮТ; решает
   * `runById`, который лежит в той же meta и рядом уже используется.
   */
  const ranByOther = $derived(
    runBy &&
      meta.current.runById !== session.me.id &&
      (cellState === 'ok' || cellState === 'error')
      ? tr('room.ui.421', { p0: runBy })
      : null,
  )

  /**
   * The runner's face, when the person who pressed Run is still in the room.
   *
   * По карте, а не поиском по списку: этот вопрос задаёт каждая ячейка с
   * выводом, и перебор по всем вкладкам комнаты в каждой из них — работа,
   * растущая произведением (двести ячеек на пятьсот вкладок — сто тысяч
   * сравнений на кадр присутствия). Карта считается один раз на тик, рядом со
   * списком (lib/peers.ts · peersById).
   */
  const runner = $derived.by(() => {
    const who = meta.current.runById
    if (!who) return null
    return session.peersById.get(who) ?? null
  })

  /** 1st, 2nd, 3rd: the queue chip reads as a place in line, not as a count. */
  function place(n: number): string {
    const teens = n % 100
    const suffix = teens >= 11 && teens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
    return `${n}${suffix}`
  }

  /*
   * Кто правит ЭТУ ячейку — и почему строки нет под своим листом.
   *
   * Присутствие здесь про общий Y.Text: в консилиуме его правит преподаватель,
   * готовя эталон. У студента на экране в это время только свой лист — и
   * строка «Мария Кузнецова редактирует здесь» читалась под ним как «она сидит
   * в вашем листе». Что текст видит преподаватель, лист говорит подписью в
   * шапке; больше про чужие каретки сказать нечего — их тут физически нет
   * (свой документ, своё пустое присутствие).
   */
  const editingHere = $derived.by(() => {
    if (ownSheet) return null
    const names = peersHere.current.map((peer) => peer.user.name)
    if (names.length === 0) return null
    if (names.length === 1) return tr('room.ui.422', { p0: names[0] })
    if (names.length === 2) return tr('room.ui.423', { p0: names[0], p1: names[1] })
    return tr('room.ui.424', { p0: names[0], p1: names[1], p2: names.length - 2 })
  })

  let aiReady = $state(false)

  // Asked only where the answer changes what is drawn, so a notebook that never
  // fails never asks. The promise behind it is shared across every cell.
  $effect(() => {
    if (!hasError) return
    // Правила читаются синхронно, а не внутри .then: из промиса эффект их не
    // отслеживает, и семинар, переключённый с hints на full посреди пары, не
    // перерисовывал кнопку до смены состояния ячейки.
    const rules = readRules(session.session.rules)
    let alive = true
    void oracleStatus().then(
      ({ enabled, mode }) => {
        // Narrowed to this room: an instance on `full` still has to obey a
        // seminar set to hints, and this button is exactly what hints refuses.
        const here = oracleModeIn(rules, mode)
        if (alive) aiReady = enabled && actionAllowedIn(here, 'fix')
      },
      // Спросим снова со следующим трейсбеком: кеш отказ не запомнил.
      () => {
        if (alive) aiReady = false
      },
    )
    return () => {
      alive = false
    }
  })

  /*
   * «Попросить оракула переписать ячейку» — и та же ловушка, что у «Fix with AI».
   *
   * Кнопка гасла только по `may.ask` (то есть по концу занятия). А `edit` —
   * действие, которое режим `hints` не принимает вовсе (protocol.ts ·
   * actionAllowedIn), и режим `off` тем более: студент открывал строку, писал
   * фразу, жал «Ask for a rewrite» и получал 403 уже после работы. Шапка этого
   * файла описывает ровно эту ловушку и закрывает её — но закрывала только для
   * `fix`.
   *
   * Спрашиваем тем же общим на вкладку обещанием и той же парой функций, что и
   * маршрут, который отказывает.
   */
  const REWRITE_OFF = $derived(tr('room.ui.425'))
  const REWRITE_HINTS = $derived(tr('room.ui.426'))
  let rewriteReady = $state(false)
  let rewriteWhy = $state<string | null>(null)

  $effect(() => {
    // После звонка спрашивать всё равно нечем: `mayRewrite` уже false, и
    // тревожить инстанс двумястами обещаний из-за одной погашенной кнопки незачем.
    if (!may.ask) return
    const rules = readRules(session.session.rules)
    let alive = true
    void oracleStatus().then(
      ({ enabled, mode }) => {
        if (!alive) return
        const here = enabled ? oracleModeIn(rules, mode) : 'off'
        rewriteReady = actionAllowedIn(here, 'edit')
        rewriteWhy = rewriteReady ? null : here === 'hints' ? REWRITE_HINTS : REWRITE_OFF
      },
      // Спросим снова со следующей перерисовкой: отказ кеш не запомнил.
      () => {
        if (!alive) return
        rewriteReady = false
        rewriteWhy = tr('room.ui.427')
      },
    )
    return () => {
      alive = false
    }
  })

  /**
   * И — только там, где эту ячейку вообще можно менять.
   *
   * «Попросить оракула изменить ячейку» кончается предложением с кнопкой
   * «Применить»: это правка тетради, а не ответ. В лекции (`edit: host`) и в
   * запертой ячейке править её участник не может — а строку вопроса ему
   * рисовали, он писал фразу, тратил вопрос из лимита комнаты и получал
   * предложение, которое сам же и не может принять. Отказ при этом молчал бы
   * дважды: и про правило, и про потраченный вопрос.
   *
   * Консилиум — отдельным слагаемым, и это не придирка. Правило `edit` в
   * открытой комнате разрешает участнику править ячейки, но общая ячейка
   * консилиума — не его: в ней задание, и переписывать его под себя означало
   * бы переписать задание всему классу. Свой лист у него при этом есть, и у
   * листа есть своя подсказка оракула — личная и без правки чужого текста.
   *
   * Преподаватель сохраняет действие везде, включая консилиум: эталон в общей
   * ячейке — его текст.
   */
  const mayPatchHere = $derived(mayEdit && (leads || !inCouncil))
  /** Один отказ на оба нажатия: попросить правку и принять её. */
  const patchWhy = $derived(inCouncil && !leads ? tr(COUNCIL_SHARED_CELL) : editWhy)
  /** Строка вопроса живая ровно тогда, когда её примут. */
  const mayRewrite = $derived(may.ask && rewriteReady && mayPatchHere)
  const rewriteRefusal = $derived(
    !may.ask
      ? may.askWhy
      : !mayPatchHere
        ? patchWhy
        : (rewriteWhy ?? tr('room.ui.427')),
  )

  // Право пропало под руками — открытую строку закрыть, иначе она обещает то,
  // чего уже нет (тот же довод, что у выхода из исходника заметки).
  $effect(() => {
    if (!mayRewrite) asking = false
  })

  let root = $state<HTMLDivElement | null>(null)

  /* ------------------------------------------------------------- parking */

  /**
   * A cell nobody can see renders a box the size of what it last measured
   * instead of a CodeMirror instance and its outputs. It stays mounted, so its
   * subscriptions and its edit state survive and coming back is a render rather
   * than a rebuild.
   */
  const PARK_ESTIMATE = 180

  let contentHeight = $state(0)
  let parkHeight = $state(PARK_ESTIMATE)

  $effect(() => {
    if (contentHeight > 0) parkHeight = contentHeight
  })

  /*
   * Never park a cell that is running, selected, or holding the local cursor.
   * Queued is deliberately not on that list: Run All queues the whole notebook
   * at once, and pinning on it would build forty editors at the exact moment
   * the machine has the least to spare. The gutter ordinal and the queue chip
   * live outside the parked region, so a parked cell still shows its place.
   */
  /*
   * Якорь, а не всё выделение.
   *
   * Выделенная ячейка не паркуется — иначе экран прыгал бы под курсором. Но
   * выделенных теперь бывает много: выделив сорок ячеек, чтобы спросить про
   * них разом, человек построил бы сорок редакторов CodeMirror — ровно ту
   * работу, ради избавления от которой парковка и написана. Курсор всё равно
   * в одной.
   */
  const pinned = $derived(anchor || focusWithin || editing || running)
  const mounted = $derived(near || pinned)

  onMount(() => {
    /*
     * A note with nothing in it has nothing to render; drop straight into edit.
     *
     * Только у того, кто её завёл. Ячейка приезжает по CRDT пустой и монтируется
     * у всей комнаты в тот же миг, а выйти из редактора зрителю нечем: `editing`
     * сбрасывают только свой blur, Escape и смена вида, а в лекционной комнате
     * редактор ещё и не берёт фокус. Тридцать человек до конца пары смотрели на
     * markdown-исходник вместо прозы — и на живой CodeMirror, который из-за
     * `editing` не паркуется.
     *
     * `selected` и есть «завёл я»: вставка выделяет ячейку в той же синхронной
     * паре, что и создаёт её (см. addAt в Notebook.svelte).
     */
    if (!selected) return
    // И только если печатать в ней можно: пустая закрытая заметка — это тупик
    // из разбора выше, просто открытый не щелчком, а появлением ячейки.
    if (!mayEdit) return
    if (meta.current.type === 'markdown' && liveText.current.trim() === '') {
      focusOnEdit = true
      editing = true
    }
  })

  async function focusEditor() {
    await tick()
    const find = () => root?.querySelector<HTMLElement>('.cm-content') ?? null
    const node = find()
    /*
     * `preventScroll` — потому что экран ведёт тетрадь, а не фокус.
     *
     * Голый `focus()` прокручивает КАЖДЫЙ прокручиваемый предок так, чтобы
     * поле стало видно «как-нибудь», и делает это минимальным ходом. Именно он
     * и оставлял Shift+Enter посреди следующей ячейки: тетрадь уже вела экран
     * к её верху с местом под тулбар, а фокус тут же обрывал ход и доводил до
     * первой строки у самого края. Куда везти — решено одним местом
     * (`reveal` в Notebook.svelte); здесь берут только курсор.
     */
    if (node) {
      node.focus({ preventScroll: true })
      return
    }
    // The cell was inserted or unparked a moment ago and CodeMirror has not
    // been built yet.
    requestAnimationFrame(() => find()?.focus({ preventScroll: true }))
  }

  function enter() {
    onselect()
    if (isCode) {
      void focusEditor()
    } else {
      /*
       * У закрытой ячейки исходник не открывается вовсе.
       *
       * Два вида у заметки — прочитанный и исходник, — и второй существует
       * ровно затем, чтобы в нём печатать. Пока сюда пускали всех, студент
       * двойным щелчком (или Enter из командного режима) разбирал прозу
       * семинара в сырой markdown и оставался в нём: выйти было нечем. Выход
       * висит на редакторе — Escape внутри CodeMirror и уход фокуса, — а
       * закрытый редактор фокуса не берёт: `contenteditable=false` не
       * фокусируется, значит ни одно из двух событий не наступает никогда.
       *
       * Вслух, а не молча: сюда приходят намеренным жестом, и жест, не
       * сделавший ничего, читается как поломка. Слова те же, что у кнопки
       * «править» в тулбаре и у отказа на Cmd+Enter.
       */
      if (!mayEdit) {
        session.showError(editWhy + '.')
        return
      }
      focusOnEdit = true
      editing = true
    }
  }

  function commitMarkdown() {
    editing = false
    focusOnEdit = false
  }

  /*
   * А если человек уже в исходнике — выйти он обязан в любом случае.
   *
   * Право пропадает под ногами: преподаватель закрывает ячейку, меняет правило
   * или звенит звонок, — и заметка, открытая честно, превращается в тот же
   * тупик, из которого нет Escape. Возврат к прочитанному виду здесь и есть
   * выход, и он не спрашивает, откуда в неё вошли.
   */
  $effect(() => {
    if (!isCode && editing && !mayEdit) commitMarkdown()
  })

  /**
   * Запустить — и сказать, получилось ли.
   *
   * Кнопку в тулбаре мы починили, но клавиши шли мимо неё: Cmd+Enter на уже
   * работающей ячейке отправлял `run`, сервер его молча выбрасывал, и человек
   * оставался с ощущением, что нажатие не дошло. Возвращаемое значение нужно
   * тем двум, кто вызывает `run` перед тем, как что-то сделать с тетрадью:
   * шагнуть и вставить ячейку от имени выполнения, которого не было, — это
   * правка документа у всей комнаты за чужой счёт.
   */
  function run(): boolean {
    if (!isCode) {
      /*
       * Текстовая ячейка «выполняется» тем, что превращается в текст.
       *
       * Возвращать здесь false нельзя, хотя запускать нечего: на этом значении
       * стоят Shift+Enter и Alt+Enter, и с false заметка отрисовывалась, но
       * курсор больше никуда не шёл и новая ячейка не появлялась. Правку
       * состояния выполнения это не касается — её тут просто нет.
       */
      commitMarkdown()
      return true
    }
    if (!mayRun) {
      // Словами сервера, дословно. Кнопка, которая молчит, — это сообщение об
      // ошибке; кнопка, которая объясняет, — это правило.
      /*
       * Из `may`, а не литералом: здесь стояла английская фраза про правило
       * комнаты, и после звонка она рассказывала про правило, которого никто не
       * менял, — человек шёл искать преподавателя вместо того, чтобы узнать,
       * что пара кончилась. То же самое уже починено в командном режиме
       * (Notebook.svelte), в редакторе оставалось.
       */
      session.showError((shut ? tr(LECTURE_CELL) : may.runWhy) + '.')
      return false
    }
    // Молча: ячейка сама показывает, что она делает, — и полосой, и строкой
    // состояния, и лицом кнопки. Плашка про то, что и так видно, — это шум.
    if (cellState === 'running' || cellState === 'queued') return false
    /*
     * «По одной»: сервер возьмёт у участника одну ячейку зараз и на вторую
     * ответит отказом — а Shift+Enter и Alt+Enter к тому моменту уже шагнули и
     * дописали пустую ячейку в общую тетрадь. Проверяем тем же счётом и теми
     * же словами.
     */
    if (
      may.rules.run === 'single' &&
      session.me.role !== 'host' &&
      hasPendingRun(session.doc, session.me.id)
    ) {
      session.showError(tr(ONE_AT_A_TIME))
      return false
    }
    onselect()
    session.send({ t: 'run', cellId: id })
    return true
  }

  async function runAndAdd() {
    if (!run()) return
    // Alt+Enter дописывает ячейку — а дописывать в этой комнате может быть
    // нельзя. Тогда запуск состоялся, а ячейка не появляется, и это правильно:
    // без проверки она появлялась бы у автора и отказывалась сервером.
    if (!may.add) {
      session.showError(may.structureWhy + '.')
      return
    }
    const created = insertCellAfter(session.doc, bookRoot, id, meta.current.type)
    session.selectCell(created)
    await tick()
    window.dispatchEvent(new CustomEvent('colloq:enter-cell', { detail: { cellId: created } }))
  }

  /**
   * Run, then go on — the pair everyone's fingers already know.
   *
   * Shift+Enter and Cmd+Enter both used to do exactly the same thing, so half
   * of a convention this notebook otherwise imitates down to `In [3]` was
   * missing: there was no way to run a cell and move on without also inserting
   * one. Shift+Enter now steps to the next cell and makes one only when there
   * is no next cell; Cmd/Ctrl+Enter runs and stays; Alt+Enter runs and inserts.
   */
  function runAndStep() {
    if (!run()) return
    step(1, true, false, true, false)
  }

  /**
   * Only Notebook knows the cell order, so hand-offs go through it.
   *
   * `scroll` отдельно от `focus` — потому что это разные вопросы. Курсор после
   * Shift+Enter переходит в следующую ячейку (пальцы этого ждут), а экран
   * остаётся на выводе той, которую запустили: «запускаю ячейку и хочу
   * посмотреть на её вывод, а меня перекидывает вниз». Переход же стрелкой из
   * последней строки — наоборот, обязан довести ячейку до глаза, иначе курсор
   * уходит за край.
   */
  function step(direction: -1 | 1, focus = true, fallback = false, grow = false, scroll = true) {
    window.dispatchEvent(
      new CustomEvent('colloq:step-cell', {
        detail: { cellId: id, direction, focus, fallback, grow, scroll },
      }),
    )
  }

  /**
   * Backspace на опустевшей ячейке — но не на той, под которой лежит вывод.
   *
   * Текст стёрли, а вывод остался: график, таблица, трейсбек, ради которого
   * ячейку и держат. Удаление уносит его у всей комнаты и без истории — а
   * жест, которым сюда пришли, это стирание последней буквы, а не решение.
   * Убрать её по-настоящему по-прежнему можно — корзиной в тулбаре и `d d`, —
   * и оба места об этом говорят.
   */
  function deleteIfEmpty() {
    if (!emptyCellIsRemovable(outputs.current.length)) {
      session.showError(tr('room.ui.428'))
      return
    }
    removeSelf(true)
  }

  function removeSelf(focus: boolean) {
    if (!may.remove) {
      session.showError(may.structureWhy + '.')
      return
    }
    // Hand the selection on first, while this cell is still in the list. `fallback`
    // covers deleting the very first cell, which has no cell above it to land on.
    step(-1, focus, true)
    deleteCell(session.doc, id)
  }

  function askAi(action: AiAction) {
    session.selectCell(id)
    window.dispatchEvent(new CustomEvent('colloq:ask-ai', { detail: { cellId: id, action } }))
  }

  /* ------------------------------------------------------ asking for an edit */

  /*
   * The oracle button used to fire 'explain' and open the panel — one canned
   * question, and the answer arrived somewhere else on the screen. What a person
   * actually wants at a cell is to say what is wrong with it in their own words
   * and get the corrected cell back where the cell is.
   *
   * So the button opens a line to type on, right under the cell, and the answer
   * comes back as a diff over that same cell. The thread still gets everything —
   * the question, the reasoning, the code — because the room is entitled to know
   * why the notebook it is reading changed.
   */
  let asking = $state(false)
  let prompt = $state('')
  let sending = $state(false)
  let askError = $state<string | null>(null)
  let promptBox = $state<HTMLTextAreaElement | null>(null)

  async function sendEdit(): Promise<void> {
    const message = prompt.trim()
    if (!message || sending) return
    sending = true
    askError = null
    try {
      await api.aiAsk(session.session.id, session.token, { message, action: 'edit', cellId: id })
      prompt = ''
      asking = false
    } catch (cause) {
      askError = cause instanceof Error ? tr(cause.message) : tr('room.ui.429')
    } finally {
      sending = false
    }
  }

  /*
   * The proposal is read from the shared document, not held here: it belongs to
   * the room. Two people looking at this cell see the same offer, and when one
   * of them decides, the other watches it resolve.
   */
  const patch = watchPatchFor(session.doc, () => id)
  const proposal = $derived(patch.current)
  /**
   * Текст ячейки — ОДИН наблюдатель, и только там, где текст правда читают.
   *
   * Их было два: `source` следил за заметками (из него рисуется прочитанный
   * вид), а этот — за всеми ячейками подряд, ради диффа предложения, которого
   * обычно нет. На заметке они дублировали друг друга, а на кодовой ячейке
   * второй нарушал ровно то правило, о котором предупреждает шапка yreactive:
   * `Y.Text.toString()` пересобирает всю строку на КАЖДОЕ нажатие — своё и
   * чужое, у всех пятисот, — и перезапускает за собой `proposedLines`,
   * `proposedCounts` и `proposedTokens`.
   *
   * Текст кодовой ячейки живёт в CodeMirror и отсюда не рисуется. Он нужен
   * ровно в двух случаях: пока стоит открытое предложение оракула (дифф) и в
   * консилиуме, где студенту показывают общую ячейку эталоном. Вне их
   * подписки нет вовсе, и `current` отдаёт пустую строку — её никто не читает.
   */
  const liveText = watchText(() => (!isCode || proposal || ownSheet ? cell.current : null))

  const proposedLines = $derived.by(() => {
    const proposed = proposal?.get('patch')
    if (typeof proposed !== 'string') return []
    return diffLines(liveText.current, proposed)
  })
  const proposedCounts = $derived(diffCounts(proposedLines))
  // Painted by the editor's own rules, so the proposal reads like the cell it
  // is offering to replace rather than like a quotation of it.
  $effect(() => {
    if (proposal) void loadSyntax()
  })
  const proposedTokens = $derived(
    diffTokens(proposedLines, liveText.current, (proposal?.get('patch') as string) ?? '', syntax()),
  )
  const proposalStale = $derived(proposal ? patchIsStale(session.doc, proposal) : false)

  /*
   * Решает сервер, а не эта вкладка. См. ChatTurn.decide: две вкладки,
   * читающие `'open'` каждая в своей копии, писали патч в ячейку дважды.
   */
  function accept(): void {
    const id = proposal?.get('id')
    if (typeof id !== 'string') return
    if (!mayPatchHere) {
      session.showError(patchWhy + '.')
      return
    }
    session.send({ t: 'ai:decide', entryId: id, accept: true })
  }

  function decline(): void {
    const id = proposal?.get('id')
    if (typeof id !== 'string') return
    /*
     * После звонка отклонять нельзя, хотя правила про это нет.
     *
     * Пока занятие идёт, «Отклонить» ничего не рушит: не понравилось —
     * спросили ещё раз. После конца пары спрашивать нечем, оракул отвечает
     * одному преподавателю, — и снятая плашка уносит с собой чужую работу
     * навсегда. Та же граница стоит на сервере.
     */
    if (!acts) {
      session.showError(tr(CLASS_IS_OVER) + '.')
      return
    }
    session.send({ t: 'ai:decide', entryId: id, accept: false })
  }

  $effect(() => {
    if (asking) promptBox?.focus()
  })

  function convert() {
    if (!mayEdit) {
      session.showError(editWhy + '.')
      return
    }
    setCellType(session.doc, id, isCode ? 'markdown' : 'code')
    // Whichever way it went, the cell re-renders in its resting form.
    focusOnEdit = false
    editing = false
  }

  $effect(() => {
    const onEnterCell = (event: Event) => {
      const detail = (event as CustomEvent<{ cellId: string }>).detail
      if (detail?.cellId === id) enter()
    }
    window.addEventListener('colloq:enter-cell', onEnterCell)
    return () => window.removeEventListener('colloq:enter-cell', onEnterCell)
  })

  /*
   * Запуск из командного режима — сюда, а не своими проверками в тетради.
   *
   * Notebook.svelte спрашивал `may.run` — правило КОМНАТЫ, — а здесь и на
   * сервере правило складывается с замком (`mayRunThisCell`). На лекции
   * преподаватель открывает ячейку: кнопка на ней живая, Cmd+Enter в редакторе
   * работает, а Shift+Enter из командного режима отвечал тостом про правило —
   * про ячейку, которая открыта. Заодно уходит вторая беда: командный
   * Shift+Enter слал `run` и для заметки, которую сервер молча выбрасывает.
   *
   * `focus: false` у шага — потому что пришли с клавиатуры в командном режиме
   * и в редактор не входим.
   */
  $effect(() => {
    const onRunCell = (event: Event) => {
      const detail = (event as CustomEvent<{ cellId: string; step?: boolean }>).detail
      if (detail?.cellId !== id) return
      if (!run()) return
      if (detail.step) step(1, false, false, true, false)
    }
    window.addEventListener('colloq:run-cell', onRunCell)
    return () => window.removeEventListener('colloq:run-cell', onRunCell)
  })

  const TOOL_BASE =
    // 24px square: WCAG 2.5.8's floor, and the difference between hitting
    // "move cell up" and hitting the cell above it on a trackpad.
    'inline-flex h-6 w-6 items-center justify-center text-muted transition-colors ' +
    'duration-[var(--speed-quick)] focus-visible:outline-none focus-visible:ring-2 ' +
    'disabled:opacity-30 disabled:hover:bg-transparent'
  const TOOL = `${TOOL_BASE} hover:bg-line hover:text-ink focus-visible:ring-accent/50`
  const TOOL_DANGER = `${TOOL_BASE} hover:bg-danger/15 hover:text-danger focus-visible:ring-danger/40`

  /** The strip under a cell body: aligned to the code, not to the rule. */
  const FOOTER = 'mt-2.5 flex items-center gap-2 pl-5'
  /**
   * Caps voice for every small label in the sheet: cell state, run credits,
   * the cell's own actions. 11px rather than 10 — see the note on the two
   * smallest steps in tailwind.config.js. This one constant is most of the
   * 525 runs of 10px the workspace was carrying.
   */
  const CAPS = 'text-2xs font-bold uppercase tracking-label'
  /**
   * Чип состояния и полоса слева говорят одно и то же двумя способами: словом
   * и цветом. Врозь они бессмысленны — цвет без слова не переживает ни
   * проектор, ни дальтонизм, слово без цвета не читается из середины
   * аудитории, — поэтому обе таблицы стоят рядом и меняются вместе.
   */
  const SHEET_CHIP = {
    edited: 'bg-warning/15 text-warning',
    correct: 'bg-positive/15 text-positive',
    wrong: 'bg-danger/10 text-danger',
    submitted: 'bg-brand/10 text-brand-2',
    /* Черновик чипа не получает вовсе — см. подвал: сказать о нём нечего. */
    draft: '',
  } as const
  /**
   * Полоса — на всю высоту листа: код, вывод и письмо преподавателя стоят под
   * одним цветом, потому что всё это одна попытка.
   *
   * Покой и правка цвета не берут вовсе и отдают полосу обычной ячейке: пока
   * человек пишет, важнее, что ячейка выбрана, стоит в очереди или упала.
   * Старая отметка при этом перестаёт быть правдой — она уходит в слово
   * «было:» рядом с чипом, а не остаётся цветом.
   */
  const SHEET_RULE = {
    edited: '',
    correct: 'border-positive',
    wrong: 'border-danger',
    submitted: 'border-brand',
    draft: '',
  } as const
</script>

{#snippet openMark()}
  <!--
    «Открыта для всех» — метка, а не второй орган управления: закрывают ту же
    ячейку тем же замком слева. Стоит она внутри тела, над первой строкой: это
    свойство КОДА, который ниже, и читаться должно вместе с ним, а не отдельной
    плашкой над ячейкой.
  -->
  {#if lock && cellOpen}
    <p class={cn(CAPS, 'pb-1 pt-0.5 text-accent-text')}>{tr('room.ui.333')}</p>
  {:else if inCouncil && leads}
    <!--
      У преподавателя в консилиуме общий текст — эталон: то, что он покажет,
      ляжет сюда. Подпись говорит, что это за текст, потому что под ним стоит
      пульт с чужими попытками, и без слов их легко перепутать.
    -->
    <p class={cn(CAPS, 'flex flex-wrap items-center gap-x-2 pb-1 pt-0.5 text-accent-text')}>
      <span>{tr('room.ui.34')}</span>
      <span class="font-normal normal-case tracking-normal text-muted"> {tr('room.ui.334')} </span>
    </p>
  {/if}
{/snippet}

{#if cell.current && ytext}
  <div
    bind:this={root}
    role="group"
    aria-label={selected ? tr('room.extra.98', { p0: index + 1 }) : tr('room.extra.99', { p0: index + 1 })}
    data-cell-id={id}
    onfocusin={() => (focusWithin = true)}
    onfocusout={(event) => {
      const next = event.relatedTarget as Node | null
      focusWithin = next !== null && event.currentTarget.contains(next)
    }}
    class="group flex gap-4"
  >
    <!-- Gutter: one ordinal, coloured by state. It stays put on hover — the
         artboard draws the toolbar over a cell whose number is still legible,
         and Run lives in that toolbar rather than under the number. -->
    <!-- Номер прижат вправо флексом, а не `text-align` на блоке во всю ширину:
         залитая метка выделения обязана обнимать две цифры, а не красить всё
         поле от края до края. -->
    <!--
      Замок стоит в поле слева, рядом с номером, — и только там, где он что-то
      решает (см. `lock`). Поле в этой комнате шире у ВСЕХ ячеек, а не у
      запертых: замок то появлялся бы, то исчезал вместе с открытием одной
      ячейки, и вся тетрадь ездила бы вбок на каждое нажатие преподавателя.
    -->
    <div
      class={cn(
        'flex h-7 shrink-0 select-none items-start justify-end gap-1.5',
        // 3.5rem вместе с `gap-4` соседа даёт 4.5rem до тела ячейки — то же
        // число, которым Notebook.svelte отодвигает свою черту и нижний ряд
        // кнопок. Меняя одно, менять и там: иначе линия вставки повиснет левее
        // ячеек, под которые она подводится.
        lock ? 'w-14' : 'w-8',
      )}
    >
      {#if lock}
        <!--
          Нажимается он у преподавателя, и только у него: `cell:open` сервер
          принимает от ведущего. Проверка тут по роли, а не по правам на эту
          ячейку, — иначе участник, которому ячейку ТОЛЬКО ЧТО открыли, получил
          бы живую кнопку «закрыть» и отказ в ответ на нажатие.
        -->
        {#if may.role === 'host'}
          <!--
            У преподавателя замок нажимается, и второе нажатие возвращает всё
            назад. Диалога нет намеренно: ячейку открывают посреди фразы, не
            отводя глаз от аудитории, и подтверждение здесь стоило бы дороже
            любой ошибки — ошибка чинится тем же нажатием.

            Поле выставляет сервер, обратно оно приезжает обычным кадром CRDT;
            здесь ничего не предугадывается, поэтому значок меняется тогда же,
            когда меняется у всей комнаты.
          -->
          <!--
            Третье положение — за меню: удержание, правая кнопка или щелчок по
            замку в положении, куда щелчком не попадали. Куда попадают щелчком,
            решает правило комнаты `opens`: в лекции — общий текст, в консилиуме
            — каждому свой лист, и тогда именно консилиум чинится вторым
            нажатием, а меню на каждый щелчок стоило бы секунды молчания посреди
            фразы. Подсказка обязана обещать ровно то, что случится, — слова
            считает lib/lock-button.ts по тому же правилу.
          -->
          <div class="relative">
            <button
              type="button"
              data-lock-button
              class={cn(
                /*
                 * 24×24 — пол WCAG 2.5.8, тот самый, ради которого сделаны
                 * 24-пиксельными все соседние кнопки тулбара (TOOL_BASE ниже).
                 * Замок был 20×20 — при том что это самая частая кнопка
                 * преподавателя в лекции и единственная с удержанием.
                 * Отрицательные поля возвращают цели прежнее МЕСТО в раскладке
                 * (20 px, центр там же), так что колонка с номером не едет.
                 *
                 * Переход перечислен свойствами, а не `transition-colors` плюс
                 * `.press`: утилита Tailwind переписывает transition-property
                 * целиком, и transform из помощника в список бы не попал —
                 * ровно та ловушка, что описана у CAP в Notebook.svelte.
                 */
                'mt-0.5 -mx-0.5 inline-flex h-6 w-6 items-center justify-center',
                'transition-[color,background-color,transform] duration-press ease-out',
                'enabled:active:scale-[0.97]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                'disabled:pointer-events-none disabled:opacity-40',
                cellOpen || inCouncil
                  ? 'bg-accent/15 text-accent-text'
                  : 'text-faint hover:bg-line hover:text-ink',
              )}
              disabled={controlDisabled(session.connected)}
              aria-pressed={cellOpen || inCouncil}
              aria-haspopup="menu"
              aria-expanded={lockMenu}
              aria-label={lockLabel(lockState, opens)}
              title={controlTitle(session.connected, lockHint(lockState, opens))}
              onclick={pressLock}
              onpointerdown={startHold}
              onpointerup={endHold}
              onpointerleave={endHold}
              onpointercancel={endHold}
              oncontextmenu={(event) => {
                event.preventDefault()
                endHold()
                lockMenu = true
              }}
            >
              <!-- Приглушённый значок = «нажатие ушло, кадра ещё нет». Не
                   предугаданное положение, а признак отправки: см. markSending. -->
              <Icon
                name={lockIcon}
                size={13}
                class={cn('transition-opacity duration-press ease-out', lockSending && 'opacity-60')}
              />
            </button>
            {#if lockMenu}
              <!--
                Слева от тетради места нет — меню раскрывается вправо, поверх
                тела ячейки. Ручки консилиума стоят и вне консилиума, но
                погашены: чтобы было видно, что они есть и где они, до того как
                положение выбрано.
              -->
              <div
                role="menu"
                tabindex="-1"
                data-lock-menu
                class="absolute left-0 top-full z-30 mt-1 w-64 border border-line bg-canvas p-1 shadow-pop"
              >
                {#each LOCKS as item (item.state)}
                  {@const current = lockState === item.state}
                  <button
                    role="menuitemradio"
                    type="button"
                    aria-checked={current}
                    class={cn(
                      'flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-ui',
                      'transition-colors duration-100',
                      current ? 'bg-raised text-ink' : 'text-ink hover:bg-raised',
                    )}
                    onclick={() => setLock(item.state)}
                  >
                    <Icon
                      name={item.icon}
                      size={13}
                      class={cn('mt-0.5 shrink-0', current ? 'text-accent-text' : 'text-muted')}
                    />
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span>{item.label}</span>
                      <span class="text-2xs text-muted">{item.hint}</span>
                    </span>
                    {#if current}
                      <Icon name="check" size={12} class="mt-1 shrink-0 text-accent-text" />
                    {/if}
                  </button>
                {/each}
                <!--
                  Пульт открывается ИЗ ЗАМКА, а не из панели инструментов и не
                  из меню комнаты: место, где ячейку сделали консилиумной, и
                  есть место, где ею управляют. Отдельная строка под тремя
                  положениями — потому что это не четвёртое положение замка, а
                  действие над третьим.
                -->
                {#if inCouncil}
                  <button
                    type="button"
                    class={cn(
                      'flex w-full items-center gap-2 bg-surface py-2.5 pl-[66px] pr-3.5 text-left',
                      'transition-colors duration-100 hover:bg-raised',
                    )}
                    onclick={openCouncilPult}
                  >
                    <span class="flex-1 text-ui font-bold text-brand">{tr('room.ui.1366')} ↗</span>
                    <span class="shrink-0 font-mono text-micro text-faint">{tr('room.ui.1367')}</span>
                  </button>
                {/if}
                <div class="my-1 h-px bg-line-soft"></div>
                <label class="flex flex-col gap-1 px-2.5 py-1.5 text-ui">
                  <span>{tr('room.ui.335')}</span>
                  <select
                    class="h-8 w-full border border-line bg-canvas px-2 text-ui text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    value={String(councilSettings.studentRun)}
                    disabled={!inCouncil || controlDisabled(session.connected)}
                    onchange={(event) => {
                      const selected = event.currentTarget.value
                      event.currentTarget.value = String(councilSettings.studentRun)
                      setStudentRun(selected === 'request' ? 'request' : selected === 'true')
                    }}
                  >
                    <option value="false">{tr('room.ui.336')}</option>
                    <option value="true">{tr('room.ui.337')}</option>
                    <option value="request">{tr('room.ui.338')}</option>
                  </select>
                </label>
                <!--
                  Про общее ядро говорится там, где ручку включают.

                  Прежде здесь и в подсказке кнопки стояло только «в очередь, по
                  одному» — это про очередь, а не про состояние: попытка видит
                  `df` преподавателя (иначе консилиум был бы бесполезен), и её
                  запись в этот `df` остаётся после неё. Имена, заведённые самой
                  попыткой, сервер снимает (kernel/index.ts ·
                  COUNCIL_SNAPSHOT_NAMES), и строка описывает ровно это. Копия
                  одна на весь продукт — shared/notebook.ts, чтобы подсказка
                  кнопки и эта строка не разъехались.
                -->
                {#if inCouncil}
                  <p class="px-2.5 pb-1 pt-0.5 text-2xs text-muted">{tr(COUNCIL_SHARED_KERNEL_NOTE)}</p>
                {/if}
                <!--
                  «Имена на проекторе» вернулись сюда вместе с исполнением.

                  Ручку убирали, когда она писалась в документ и не читалась
                  ничем: переключатель, который в обе стороны не меняет ничего,
                  — обещание без исполнения. Теперь её читает сервер на подписи
                  показанной попытки: выключенная — и в кадре нет ни имени, ни
                  цвета, ни аватара, а подписывает «Вариант N» одинаково везде —
                  в тетради у всех, в плашке преподавателя и на проекторе.
                  Скрыть имя постфактум нельзя: то, что уже уехало в чужой
                  браузер, считается показанным, — поэтому ручку и щёлкают до
                  показа.
                -->
                {#if inCouncil}
                  <label class="flex items-start gap-2 px-2.5 py-1.5 text-ui">
                    <input
                      type="checkbox"
                      class="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                      checked={councilSettings.namesOnProjector}
                      disabled={controlDisabled(session.connected)}
                      onchange={(event) => setNamesOnProjector(event.currentTarget.checked)}
                    />
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span>{tr('room.ui.1258')}</span>
                      <span class="text-2xs text-muted">{tr('room.ui.1259')}</span>
                    </span>
                  </label>
                {/if}
                {#if !inCouncil}
                  <p class="px-2.5 pb-1 pt-0.5 text-2xs text-muted">{tr('room.ui.339')}</p>
                {/if}
              </div>
            {/if}
          </div>
        {:else}
          <!-- Тому, кто открыть не может, замок только показывает. Он всё
               равно нужен: иначе непонятно, почему ячейка не берёт набор. -->
          <span
            class={cn(
              'mt-1 inline-flex h-5 w-5 items-center justify-center',
              cellOpen || inCouncil ? 'text-accent-text' : 'text-faint',
            )}
            title={inCouncil
              ? tr('room.extra.109')
              : cellOpen
                ? tr('room.extra.110')
                : tr('room.extra.111')}
          >
            <Icon name={lockIcon} size={13} />
          </span>
        {/if}
      {/if}
      <!--
        Цвет номера меняется мгновенно, и это не экономия, а правило: `tone`
        переключается стрелкой, Enter и j/k, то есть сотни раз за пару. Метка
        «вот эта ячейка сейчас живая» — единственное, по чему двадцать человек
        в комнате понимают, куда смотреть; переход в 100ms сдвигает её на сто
        миллисекунд позже нажатия, и на быстром переборе ячеек цвет всё время
        догоняет курсор, вместо того чтобы стоять под ним.

        Тот же довод, что двадцатью строками ниже про кольцо фокуса: подсказка,
        пришедшая с опозданием, хуже пришедшей резко.
      -->
      <!--
        Подпись на номере — единственное место, где о времени может сказать
        ячейка без вывода: строка «Out [n]» рисуется только под выводом, а у
        текстовой ячейки её нет вовсе.
      -->
      <div
        class="flex flex-col items-end gap-[3px]"
        title={[
          mark?.tone === 'idle' ? tr('room.extra.112') : null,
          mark?.tone === 'lost' ? tr('room.extra.113') : null,
          meta.current.execCount === null ? null : tr('room.extra.114', { p0: meta.current.execCount }),
          meta.current.ranMs !== null && meta.current.ranMs >= NOTICED_MS
            ? spell(meta.current.ranMs)
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || undefined}
      >
      <span
        class={cn(
          'text-head font-black tabular-nums tracking-tight',
          /*
           * Выделенная ячейка помечена НОМЕРОМ, а не подложкой, и это
           * единственная метка, которая переживает любое состояние.
           *
           * Подложка гаснет у работающей и у упавшей — там свои цвета, и
           * закрашивать их было бы враньём. А спрашивают оракула чаще всего
           * ровно про упавшую: не видеть, попала она в выделение или нет, —
           * это вопрос, заданный вслепую.
           *
           * Цвет состояния при этом НЕ добавляется: `cn` — это clsx, он классы
           * не разрешает, и `text-ink` из `ORDINAL.selected` вместе с
           * `text-canvas` давали цифры цвета фона на фоне того же цвета —
           * тёмный прямоугольник вместо номера.
           */
          selected ? 'bg-ink px-1 text-canvas' : ORDINAL[tone],
        )}
      >
        {ordinal}
      </span>
      <!--
        Метка выполнения — под номером, моноширинным, ровно три знака.
        
        Три знака — это вертикаль: `[ ]`, `[7]` и `[*]` встают друг под другом,
        и лист читается одной колонкой сверху вниз. Ради неё же метка стоит в
        поле, а не под выводом: под выводом её нет у тех ячеек, у которых нет
        вывода, — а это половина тетради.
      -->
      {#if mark}
        <span class={cn('font-mono text-2xs leading-none', MARK[mark.tone])}>{mark.label}</span>
      {/if}
      <!--
        Сколько это заняло — здесь же, и только когда заняло сколько-нибудь
        заметное время. Под две секунды цифра сообщает, что компьютер справился
        быстро, а таких ячеек в тетради к концу пары сорок.
      -->
      {#if meta.current.ranMs !== null && meta.current.ranMs >= NOTICED_MS && !shownRunning}
        <span class="font-mono text-micro leading-none text-faint">{spell(meta.current.ranMs)}</span>
      {/if}
      </div>
    </div>

    <!--
      Ячейка нажимается там, где человек видит ячейку.

      Нажатие ловил внешний блок — а он шире того, что считают ячейкой: в него
      входит поле с номером, пустое место под ним и просвет до тела. Щелчок в
      пустоту слева выделял ячейку, и это выглядело как промах интерфейса, а не
      как выбор: целились мимо, попали в ячейку.

      Теперь нажатие слушает колонка тела — код, вывод, форма ввода, тулбар над
      ними, — а поле с номером и просветы остаются нейтральными: там не
      выделяют.

      И снимают выделение они тоже. Половины дела было мало: колонка с номером
      перестала выделять, но для снятия по-прежнему считалась ячейкой (проверка
      шла по `data-cell-id`, а он на корне), и щелчок в белое место под номером
      не делал ничего — приходилось целиться в поля тетради. Поэтому у тела
      свой признак: он и говорит, где кончается ячейка на ощупь.
    -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="relative min-w-0 flex-1"
      data-cell-body
      onpointerdowncapture={(event) => onselect(event)}
      oncontextmenucapture={(event) => {
        // Chrome on macOS emits contextmenu after Ctrl+left-click even when
        // pointerdown was cancelled. Keep CodeMirror from taking focus back.
        if (event.ctrlKey && event.button === 0) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
    >
      <!-- Out of flow and above the body: a toolbar that appeared in flow would
           push the cell down the moment the pointer arrived. -->
      <!-- Признак для тетради: она меряет этот ряд, чтобы оставить ему место
           над ячейкой, к которой ведёт экран (см. lib/cell-scroll.ts). Ряд
           стоит вне потока, и без замера Shift+Enter увозил его за верхний
           край — тулбар оказывался ровно там, куда не смотрят. -->
      <div
        data-cell-toolbar
        class={cn(
          'absolute bottom-full right-0 z-10 flex items-center gap-0.5 bg-raised px-1.5 py-0.5',
          'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          // Переход живёт только у невыбранной ячейки, и поэтому достаётся
          // ровно наведению: мышь ведут медленно и плавное проявление ей
          // помогает. У выбранной перехода нет — значит стрелка открывает
          // тулбар в том же кадре, в котором нажата. Уход с ячейки снова
          // возвращает переход, и тулбар соседа успокаивается, а не пропадает.
          !selected && 'transition-opacity duration-[var(--speed-quick)]',
          selected && 'opacity-100',
        )}
      >
        <!--
          У запертой ячейки первого слота нет вовсе — ни «запустить», ни
          погашенного «запустить». Обычно здесь гасят, а не прячут (довод ниже
          про раскладку), но в лекции у участника гаснет ВЕСЬ ряд: переставлять,
          дублировать, править и стирать ему тоже нельзя, и двигать под курсором
          нечего. Обещать кнопкой действие, которого в этой комнате нет, дороже.
        -->
        {#if isCode && !shut}
          <!--
            Одно место, три лица: запустить, убрать из очереди, остановить.

            Гасим, а не прячем, в каждом отказе — включая чужую ячейку в
            очереди, где внизу «отменить» как раз прячут. Асимметрия
            намеренная и про раскладку: внизу это последняя кнопка в ряду и
            её исчезновение ничего не двигает, а здесь пропажа первого слота
            подвинет «вверх» и «вниз» под курсор, который целился в одну из
            них. Ради этого же в run-slot.ts пришлось сочинить фразу отказа
            для «отменить», которой в продукте не было.

            Перехода на смене лица нет. `transition-colors` в TOOL отвечает
            курсору, а не состоянию, и цвет живёт на самом значке. Лицо здесь
            меняется от состояния ядра, пришедшего по сети, — плавное
            перетекание нарисовало бы кнопку, наполовину «пуск», наполовину
            «стоп», ровно в тот момент, когда человек решает, нажимать ли.
          -->
          <button
            type="button"
            class={TOOL}
            disabled={slot.disabled}
            title={slot.title}
            aria-label={slot.label}
            onclick={() => {
              if (slot.action === 'run') run()
              else if (slot.action === 'cancel') session.send({ t: 'cancel', cellId: id })
              else session.send({ t: 'interrupt', cellId: id })
            }}
          >
            <Icon name={slot.icon} size={slot.size} class={slot.tint} />
          </button>
        {:else if !isCode && !editing}
          <button
            type="button"
            class={TOOL}
            title={mayEdit ? tr('room.extra.120') : editWhy}
            aria-label={tr('room.ui.340')}
            disabled={!mayEdit}
            onclick={() => enter()}
          >
            <Icon name="text" size={13} />
          </button>
        {/if}
        <button
          type="button"
          class={TOOL}
          title={may.move ? tr('room.extra.121') : may.structureWhy}
          aria-label={tr('room.ui.341')}
          disabled={index === 0 || !may.move}
          onclick={() => session.send({ t: 'cells:move', cellId: id, direction: -1 })}
        >
          <Icon name="chevron-up" size={13} />
        </button>
        <button
          type="button"
          class={TOOL}
          title={may.move ? tr('room.extra.122') : may.structureWhy}
          aria-label={tr('room.ui.342')}
          disabled={last || !may.move}
          onclick={() => session.send({ t: 'cells:move', cellId: id, direction: 1 })}
        >
          <Icon name="chevron-down" size={13} />
        </button>
        <!--
          Один слот — два действия, по праву.

          Кому можно менять структуру, тот получает копию ячейки в тетрадь,
          как и было. Остальным (лекция, консилиум) слот не гаснет, а копирует
          текст ячейки в буфер: унести код к себе — ровно то, что студенту на
          лекции и нужно, и для этого не надо ни писать в общую тетрадь, ни
          спрашивать правило комнаты.
        -->
        {#if may.add}
          <button
            type="button"
            class={TOOL}
            title={tr('room.extra.123')}
            aria-label={tr('room.ui.343')}
            onclick={() => duplicateCell(session.doc, bookRoot, id)}
          >
            <Icon name="duplicate" size={13} />
          </button>
        {:else}
          <button
            type="button"
            class={TOOL}
            title={copied ? tr('room.ui.1268') : tr('room.ui.1900')}
            aria-label={tr('room.ui.1900')}
            onclick={() => void copySource()}
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} />
          </button>
        {/if}
        <button
          type="button"
          class={TOOL}
          title={mayEdit ? (isCode ? tr('room.extra.124') : tr('room.extra.125')) : editWhy}
          aria-label={isCode ? tr('room.extra.126') : tr('room.extra.127')}
          disabled={!mayEdit}
          onclick={convert}
        >
          <Icon name={isCode ? 'text' : 'code'} size={13} />
        </button>
        <!-- Спросить — тоже действие: после конца занятия оракул отвечает
             одному преподавателю (may.ask), и строка, в которую человек успеет
             написать фразу, — это отказ, полученный уже после работы. То же и с
             режимом оракула: `hints` переписывать ячейку отказывается, и знать
             об этом надо ДО набранной фразы (см. `rewriteReady`). -->
        <!--
          Там, где ячейку не правят (лекция, общая ячейка консилиума), значок
          стоит на месте, но погашен — с причиной в подсказке. Не исчезает:
          тулбар у всех ячеек один, и пропавшая кнопка читается как поломка,
          а не как правило. Спросить ПРО ячейку при этом можно по-прежнему —
          вопрос живёт в панели, а не здесь.
        -->
        <button
          type="button"
          class={TOOL}
          title={mayRewrite ? tr('room.extra.128') : rewriteRefusal}
          aria-label={tr('room.ui.344')}
          aria-pressed={asking}
          disabled={!mayRewrite}
          onclick={() => (asking = !asking)}
        >
          <Icon name="sparkles" size={13} class="text-accent-text" />
        </button>
        {#if isCode}
          <!--
            Прибрать за собой в своей ячейке.

            Правило «стирать общее» про доску целиком, и сервер это различает
            (`clearOutputs` с именем ячейки спрашивает право печатать, а не
            право стирать). В комнате с `wipe: host` подсказка под правилом
            обещала, что свою ячейку человек чистит всегда, — а нажать было
            нечего: клиент умел стирать только всю тетрадь разом.
          -->
          <button
            type="button"
            class={TOOL}
            title={controlTitle(session.connected, mayEdit ? tr('room.extra.129') : editWhy)}
            aria-label={tr('room.ui.345')}
            disabled={!mayEdit || controlDisabled(session.connected)}
            onclick={() => session.send({ t: 'clearOutputs', cellId: id })}
          >
            <Icon name="eraser" size={13} />
          </button>
        {/if}
        <button
          type="button"
          class={TOOL_DANGER}
          title={may.remove ? tr('room.extra.131') : may.structureWhy}
          aria-label={tr('room.ui.346')}
          disabled={!may.remove}
          onclick={() => removeSelf(false)}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>

      <!--
        Обёртка ради одной дышащей полосы, лежащей поверх левой кромки.

        Просто блок вокруг блочных соседей, так что раскладка не меняется, а
        `bind:clientHeight` остаётся на том же внутреннем div — парковка не
        затронута. Полоса стоит вне `{#if mounted}` намеренно: работающая
        ячейка сейчас никогда не паркуется (`pinned` включает `running`), но
        если это правило когда-нибудь изменят, припаркованная работающая
        ячейка получит зажжённую кромку, а не полосу бледнее очереди.
      -->
      <div class="relative">
      {#if mounted}
        <div bind:clientHeight={contentHeight}>
          {#if ownSheet && sheet}
            <!--
              Свой лист студента в консилиуме — и это ВСЯ ячейка.

              Тот же CodeMirror, но привязан к локальному документу (см.
              `openSheet`): в общий Y.Text отсюда не уходит ни буквы. Снимок
              уезжает сам при паузе в наборе и на уходе фокуса; сдаёт кнопка
              справа и одно сочетание ⌘⇧↵.

              Над листом больше нет второй ячейки. Общий текст стоял здесь
              только чтением — «Общая ячейка, видна всей группе», — и платой за
              него был второй блок кода на экране у человека, который пишет
              свой. Задание и так читается сверху, в маркдаун-ячейке над этой, а
              показанное классу видно на проекторе; в тетради студента ему
              места нет. Вывод общей ячейки по той же причине не рисуется вовсе
              (см. область вывода ниже): под листом лежит вывод СВОЕЙ попытки, и
              два разных вывода подряд читаются как один.

              Полос здесь одна на всё: лист, вывод и письмо преподавателя стоят
              под одной кромкой одного цвета, потому что это одна попытка, а не
              три соседних блока. Подвал из-под кромки выходит — он про то, что
              с попыткой можно СДЕЛАТЬ, и выровнен по коду, как у обычной
              ячейки.
            -->
            <div
              onfocusout={(event) => {
                const next = event.relatedTarget as Node | null
                if (!next || !event.currentTarget.contains(next)) session.council.flush(id)
              }}
            >
              <div class={cn('border-l-4 px-3 py-1', SHEET_RULE[sheetState] || RULE[tone], 'bg-surface')}>
                <!--
                  Шапка листа: чем эта ячейка отличается от соседних (чип) и что
                  с попыткой уже произошло (подпись). Чип не меняется никогда —
                  по нему ячейку узнают; подпись меняется с состоянием и говорит
                  ровно то, чего не умещается в одно слово чипа в подвале.
                -->
                <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 pb-1 pt-0.5">
                  <span class={cn(CAPS, 'bg-accent/10 px-1.5 py-px text-accent-text')}>
                    {tr('room.ui.34')}
                  </span>
                  <span class="text-2xs text-muted">
                    {#if councilClosed} {tr(COUNCIL_CLOSED)} {:else if sheetState === 'edited'}
                      {mine?.correct != null ? tr('room.ui.1245') : tr('room.ui.1246')}
                    {:else if sheetState === 'correct' || sheetState === 'wrong'}
                      {reviewedAt === null
                        ? tr('room.ui.1243', { p0: clock(submittedAt ?? 0) })
                        : tr('room.ui.1242', { p0: clock(submittedAt ?? 0), p1: clock(reviewedAt) })}
                    {:else if sheetState === 'submitted'}
                      {letters.length > 0 ? tr('room.ui.1244') : tr('room.ui.1241')}
                    {:else} {tr('room.ui.1222')} {/if}
                  </span>
                  <!-- Счёт класса стоит здесь, а не в подвале: это сведение о
                       комнате, а не действие, и в подвале он спорил за место с
                       кнопками — на узкой колонке они от него уезжали вниз. -->
                  {#if count && !councilClosed}
                    <span class="font-mono text-2xs tabular-nums text-muted">{countLine(count)}</span>
                  {/if}
                </div>
                <!--
                  Сданный текст не приглушён.

                  Приглушение стояло здесь и читалось как «выцвело»: сданная
                  попытка — ровно та вещь, которую после сдачи и перечитывают,
                  а половина контраста на коде мешает именно перечитывать. Что
                  правка закрыта, говорят чип в подвале и пропавшие кнопки
                  запуска — словом и отсутствием, а не туманом.

                  Подсказки ядра здесь такие же, как в обычной ячейке, и имя
                  ячейки едет вместе с вопросом: им сервер и отличает свой лист
                  консилиума от прочих (control.ts · mayComplete). Без него в
                  лекционной комнате студент получал в ЕДИНСТВЕННОЙ ячейке, где
                  ему велено писать код, только слова из неё же — `df.` не знал
                  ни одного настоящего столбца.
                -->
                <CodeEditor
                  text={sheet.text}
                  awareness={sheet.awareness}
                  undoManager={sheet.undo}
                  language={isCode ? 'python' : 'markdown'}
                  label={tr('room.extra.132', { p0: ordinal })}
                  readOnly={!mayAttempt || submittedAt !== null}
                  placeholder={tr('room.ui.354')}
                  onfocus={() => onselect()}
                  onrun={sheetRunKey}
                  onrunstep={sheetRunKey}
                  onsubmit={submitFromKey}
                  onescape={() => root?.querySelector<HTMLElement>('.cm-content')?.blur()}
                  onarrowout={(direction) => step(direction)}
                  complete={(code, cursor) => session.complete(code, cursor, id)}
                  inspect={(code, cursor) => session.inspect(code, cursor, id)}
                  maxChars={MAX_ATTEMPT_CHARS}
                  onoverflow={(chars) =>
                    session.showError(
                      tr('room.extra.133', { p0: MAX_ATTEMPT_CHARS.toLocaleString(getLocale()), p1: chars.toLocaleString(getLocale()) }),
                    )}
                />
                <!--
                  Счётчик знаков — под листом и только к концу.

                  Раньше про потолок говорил сервер: отказ на каждую паузу в
                  наборе, то есть тост раз в секунду, из которого не следовало ни
                  сколько набрано, ни сколько можно. Счётчик появляется на
                  девяти десятых пути (council.svelte.ts · attemptCounter) и
                  говорит одно и то же число, что и отказ.
                -->
                {#if attemptCount}
                  <p
                    class={cn(
                      'flex flex-wrap items-baseline justify-end gap-x-2 pt-0.5 text-2xs',
                      attemptOver ? 'text-warning' : 'text-muted',
                    )}
                  >
                    {#if attemptOver}
                      <span>{tr('room.ui.355')}</span>
                    {/if}
                    <span class="font-mono tabular-nums">{attemptCount}</span>
                  </p>
                {/if}
              </div>
              <!-- Вывод запуска — к попытке, не к общей ячейке: приезжает автору
                   вместе с попыткой и лежит прямо под ней, под той же кромкой.
                   У общей ячейки вывода на этом экране нет вовсе, так что
                   спутать их нечем. -->
              {#if attemptRun}
                <!-- Та же пара, что у обычной ячейки: вывод на листе, код на
                     плите, между ними волосяная линия. -->
                <div
                  class={cn(
                    'border-l-4 border-t',
                    SHEET_RULE[sheetState] || RULE[tone],
                    attemptRun.state === 'error' ? 'bg-danger/5' : 'bg-canvas',
                  )}
                  style:border-top-color="rgb(var(--line))"
                >
                  {#if attemptRun.outputs.length > 0}
                    <div class="px-2 py-1.5">
                      <CellOutputs outputs={attemptRun.outputs} />
                    </div>
                  {/if}
                  <div class="px-4 pb-1.5 pt-0.5 text-2xs text-muted">
                    {ranByLine(attemptRun, spell)}
                  </div>
                </div>
              {/if}
              <!--
                Письмо преподавателя — ПОД выводом и внутри той же кромки: это
                часть попытки, а не соседний чат. Подпись — того, кто отвечал: в
                комнате может быть два преподавателя, а черновик оракула сюда
                приходит уже его словами.

                Письмо на строку, а не все в одном абзаце: личный ответ и
                рассылка группе написаны в разное время и разным людям, и
                слитно они читаются одним письмом. Групповое помечено словом —
                тогда молчание на личном значит «это вам».
              -->
              {#if letters.length > 0}
                <div
                  class={cn('border-l-4 border-t px-3 py-1.5', SHEET_RULE[sheetState] || RULE[tone], 'bg-surface')}
                  style:border-top-color="rgb(var(--line))"
                >
                  {#each letters as letter}
                    <div class="flex items-start gap-2 py-0.5">
                      <span
                        class={cn(
                          'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                          letter.to === 'oracle' ? 'bg-accent' : 'bg-brand-2',
                        )}
                        aria-hidden="true"
                      ></span>
                      <div class="min-w-0">
                        <p class="flex flex-wrap items-baseline gap-x-2 text-2xs">
                          <span class="text-ui font-bold text-ink">{letter.by}</span>
                          <span class="text-muted">
                            {letter.to === 'oracle' ? tr('room.ui.1261') : tr('room.ui.1251')} ·
                            {clock(letter.at)}
                          </span>
                          {#if letter.to === 'group'}
                            <span class="text-muted">{tr('room.ui.70')}</span>
                          {/if}
                        </p>
                        <p class="text-ui text-ink">{letter.text}</p>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
              <!--
                Показанное классу — приставкой к СВОЕЙ ячейке, а не второй ячейкой.

                Преподаватель вывел чей-то вариант: свой текст у человека
                остаётся своим, чужой прирастает снизу — под той же кромкой, без
                зазора, со сменой цвета полосы на positive и с подписью. Это
                единственное место в тетради, где кромка меняет цвет посередине,
                и живёт оно ровно столько, сколько показывают: «убрать с экрана»
                сворачивает блок, и ячейка возвращается к одной колонке.

                Складка мерена высотой (`slide`), как складка шапки: блок
                отдаёт своё место тетради целиком, а не растворяется, оставив
                дыру. Под `prefers-reduced-motion` — ноль, то есть мгновенно.
              -->
              {#if showsOnScreen && onScreen}
                <div
                  transition:slide={{ duration: prefersReducedMotion() ? 0 : 200, easing: quintOut }}
                >
                  <CouncilOnScreen shown={onScreen} />
                </div>
              {/if}
              <!--
                Переспрос про возврат — полосой во всю ячейку, а не окном
                браузера.

                `window.confirm` выбивает из страницы и выглядит чужим ровно
                там, где ответ виден тут же: в листе, который заменят. Охра —
                потому что это не ошибка и не опасность, а незаконченное
                движение: одно нажатие туда, одно обратно.
              -->
              {#if restoreAsking}
                <div
                  class="mt-px flex flex-wrap items-center gap-x-3 gap-y-1.5 border-l-4 border-warning bg-warning/10 px-3 py-2"
                  role="group"
                >
                  <span class="text-ui font-bold text-ink">{tr('room.ui.1233')}</span>
                  <span class="text-2xs text-muted">{tr('room.ui.1250')}</span>
                  <!-- Пара ответов держится вместе: на узкой колонке строка
                       переносится, и «Отмена», прижатая к краю в одиночку,
                       уезжала на строку выше своего «Вернуть». -->
                  <span class="ml-auto flex items-center gap-3">
                    <button
                      type="button"
                      class="text-2xs text-muted hover:text-ink"
                      onclick={() => (restoreAsking = false)}
                    >{tr('room.ui.1235')}</button>
                    <button
                      type="button"
                      class="btn h-7 bg-warning text-canvas hover:brightness-110"
                      onclick={restoreStub}
                    >{tr('room.ui.1234')}</button>
                  </span>
                </div>
              {/if}
              <!--
                Подвал: слева тихое «начать заново», справа — действия по
                возрастанию веса: состояние словом, запуск, сдача.

                «Восстановить» стоит на другом конце подвала от «Запустить» и
                «Сдать» нарочно: между ними половина ширины ячейки, мимо не
                попадёшь. Вес у него тихий — значок и muted, без рамки и
                заливки: спасательный круг видно, но он не спорит с главным.
              -->
              <div
                class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-5 pr-1"
                bind:clientWidth={footerWidth}
              >
                {#if !councilClosed}
                  <button
                    type="button"
                    class="inline-flex h-7 items-center gap-1.5 text-2xs text-muted transition-colors
                           duration-[var(--speed-quick)] hover:text-ink disabled:cursor-not-allowed
                           disabled:text-faint disabled:hover:text-faint"
                    disabled={!mayRestore || restoreAsking}
                    title={tr('room.ui.1240')}
                    onclick={() => (restoreAsking = true)}
                  >
                    <span aria-hidden="true">↺</span>
                    {tr('room.ui.1232')}
                  </button>
                  {#if submittedAt === null && sheetText === stubText()}
                    <span class="text-2xs text-faint">{tr('room.ui.1249')}</span>
                  {/if}
                  <!--
                    Подсказка стоит слева, рядом с «Восстановить», а не среди
                    действий справа: и то и другое — помощь застрявшему, и оба
                    тихие. Справа живёт то, что двигает попытку вперёд.
                  -->
                  {#if mayHint || hint?.asking}
                    <button
                      type="button"
                      class="inline-flex h-7 items-center gap-1.5 text-2xs text-accent-text transition-colors
                             duration-[var(--speed-quick)] hover:text-ink disabled:cursor-not-allowed
                             disabled:text-faint disabled:hover:text-faint"
                      disabled={hint?.asking || !mayHint}
                      title={tr('room.ui.1264')}
                      onclick={() => session.council.askHint(id)}
                    >
                      <Icon name="sparkles" size={12} />
                      {hint?.asking ? tr('room.ui.1263') : tr('room.ui.1262')}
                    </button>
                  {/if}
                  {#if hint?.error}
                    <span class="text-2xs text-warning" role="status">{hint.error}</span>
                  {/if}
                {/if}

                <!--
                  Действия — одной группой, прижатой вправо.

                  Не россыпью в общем флексе: там при нехватке места вниз
                  уезжала ОДНА крайняя кнопка, оставляя чип наверху, — то есть
                  ломалась ровно та связка, ради которой подвал и читают.
                  Группа переносится целиком и остаётся выровненной по правому
                  краю, как на досках.
                -->
                <span class="ml-auto flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1.5">
                {#if councilClosed}
                  <span class={cn(CAPS, 'bg-surface px-2 py-0.5 text-muted')}>{tr('room.ui.370')}</span>
                {:else}
                  {#if sheetState === 'edited' && mine?.correct != null}
                    <!-- Старая отметка больше не правда — но и не пустое место:
                         ради неё и правят. Остаётся памятью, приглушённо. -->
                    <span class="text-2xs text-faint">
                      {tr('room.ui.1247')} {mine.correct ? tr('room.ui.1225') : tr('room.ui.1226')}
                    </span>
                  {/if}
                  <!--
                    У черновика чипа нет.

                    Стоял «ЧЕРНОВИК · СОХРАНЯЕТСЯ» — два слова про то, что и так
                    происходит с каждой буквой в каждом поле продукта, на самом
                    видном месте подвала и при этом в самом частом состоянии
                    ячейки: девяносто процентов времени человек читал сообщение
                    о том, что ничего не случилось. Чип появляется там, где есть
                    что сказать: сдано, есть правки, отметка, на экране. Что
                    текст уходит преподавателю, говорит подпись в шапке — один
                    раз и наверху.
                  -->
                  {#if sheetState !== 'draft'}
                    <span class={cn(CAPS, 'px-2 py-0.5', SHEET_CHIP[sheetState])} role="status">
                      {#if sheetState === 'edited'} {tr('room.ui.1228')} {:else if sheetState === 'correct'}
                        {tr('room.ui.1225')}
                      {:else if sheetState === 'wrong'} {tr('room.ui.1226')} {:else}
                        {tr(tightFooter ? 'room.ui.1252' : 'room.ui.1224', { p0: clock(submittedAt ?? 0) })}
                      {/if}
                    </span>
                  {/if}
                  {#if mine?.shown}
                    <span class={cn(CAPS, 'bg-positive/15 px-2 py-0.5 text-positive')}>
                      {tr('room.ui.1227')}
                    </span>
                  {/if}
                  {#if !mayAttempt}
                    <span class="text-2xs text-muted">{attemptWhy}</span>
                  {/if}

                  <!--
                    Кнопок запуска у сданной попытки нет вовсе: сдано — значит
                    закрыто, и погашенная кнопка сказала бы, что дело в связи.
                    Возвращаются они вместе с правом писать — после «Изменить».
                  -->
                  {#if submittedAt === null}
                    {#if runWaiting}
                      <!--
                        Ожидание стоит НА МЕСТЕ кнопки, а не рядом с ней: ядро
                        одно на комнату, нажимать второй раз нечего, и кнопка,
                        оставшаяся живой рядом с номером в очереди, ровно это и
                        предлагала. Номер называется, когда он известен; пока
                        запрос у преподавателя, известно только, что ждём.
                      -->
                      <span
                        class={cn(CAPS, 'inline-flex h-7 items-center gap-2 border border-accent px-3 text-accent-text')}
                        role="status"
                      >
                        {mine?.queue != null
                          ? tr('room.ui.1236', { p0: mine.queue })
                          : tr('room.ui.1260')}
                        {#if mayCancelRun}
                          <button
                            type="button"
                            class="font-normal normal-case tracking-normal text-accent-text hover:underline disabled:no-underline disabled:opacity-40"
                            disabled={controlDisabled(session.connected) || requestSending !== null}
                            onclick={cancelAttemptRunRequest}
                          >{requestSending?.action === 'cancel' ? tr('room.ui.360') : tr('room.ui.1238')}</button>
                        {/if}
                      </span>
                    {:else if mayRunAttempt || mayRequestRun}
                      <!--
                        Отказ преподавателя — единственное, о чём тут говорят
                        словами: кнопка вернулась в исходное, и без строки это
                        читалось бы как «нажатие не дошло». Разошедшийся текст
                        (запрос был про прошлую версию) молчит: кнопка снова
                        живая, и нажать её — и есть весь ответ.
                      -->
                      {#if mine?.runRequest?.status === 'declined' && attemptSynced}
                        <span class="text-2xs text-muted" role="status">{tr('room.ui.364')}</span>
                      {/if}
                      <button
                        type="button"
                        class="btn-outline h-7"
                        disabled={!mayPressRun || attemptOver || controlDisabled(session.connected)}
                        title={controlTitle(
                          session.connected,
                          tr('room.extra.138', { p0: tr(COUNCIL_SHARED_KERNEL_NOTE) }),
                        )}
                        onclick={sheetRunKey}
                      >
                        {tr('room.ui.73')}
                        <span class="font-mono text-2xs text-faint">⇧↵</span>
                      </button>
                    {:else}
                      <!-- Ручка выключена: кнопки нет, и это сказано словом, а не
                           погашенной кнопкой — гасить нечего, запуск здесь не
                           ваш. -->
                      <span class="text-2xs text-faint">{tr('room.ui.1230')}</span>
                    {/if}
                  {/if}

                  <!--
                    Сдача — одна кнопка на одном месте, меняющая слово: «Сдать»
                    → «Изменить» → «Сдать заново». «Исправить» — то же
                    «Изменить», названное по делу: после «есть ошибка» кнопка
                    ведёт к выходу, а не повторяет беду.
                  -->
                  {#if sheetState === 'edited'}
                    <button
                      type="button"
                      class={cn('btn h-7 bg-warning text-canvas hover:brightness-110', submitFlash && 'brightness-90')}
                      disabled={!mayAttempt || controlDisabled(session.connected) || awaitingMine !== null}
                      title={controlTitle(session.connected, mayAttempt ? tr('room.extra.135') : attemptWhy)}
                      onclick={resubmitAttempt}
                    >{awaitingMine === 'submit' ? tr('room.ui.66') : tr('room.ui.1229')}</button>
                  {:else if submittedAt === null}
                    <button
                      type="button"
                      class={cn('btn-primary h-7', submitFlash && 'brightness-90')}
                      disabled={!mayAttempt || controlDisabled(session.connected) || awaitingMine !== null}
                      title={controlTitle(session.connected, mayAttempt ? tr('room.extra.135') : attemptWhy)}
                      onclick={() => void submitAttempt()}
                    >
                      {awaitingMine === 'submit' ? tr('room.ui.66') : tr('room.ui.356')}
                    </button>
                  {:else}
                    <button
                      type="button"
                      class="btn-outline h-7"
                      disabled={!mayAttempt || controlDisabled(session.connected) || awaitingMine !== null}
                      title={controlTitle(
                        session.connected,
                        mayAttempt ? tr('room.extra.136') : attemptWhy,
                      )}
                      onclick={withdrawAttempt}
                    >
                      {awaitingMine === 'withdraw'
                        ? tr('room.ui.66')
                        : sheetState === 'wrong'
                          ? tr('room.ui.1248')
                          : tr('room.ui.358')}
                    </button>
                  {/if}
                  {/if}
                </span>
              </div>
              <!--
                Подсказка на ⇧↵ при выключенной ручке: две секунды и гаснет.

                Не тост: тост уезжает в угол экрана, а вопрос был задан здесь,
                пальцами в этой ячейке. И не отказ — запуск не «не удался», его
                тут просто нет.
              -->
              {#if runHint}
                <p class="ml-5 mt-1.5 inline-flex items-center gap-2 bg-ink px-2.5 py-1 text-2xs text-canvas" role="status">
                  <span class="font-mono">⇧↵</span>
                  <span>{tr('room.ui.1231')}</span>
                </p>
              {/if}
              {#if mayAttempt && !councilClosed}
                <p class="pl-5 pt-1 text-2xs text-muted">{tr('room.ui.357')}</p>
              {/if}
            </div>
          {:else if showEditor}
            <!-- The focus ring lands at once: box-shadow cannot be animated
                 on the compositor, and a focus cue that arrives late is worse
                 than one that arrives hard. -->
            <div
              class={cn(
                // Без перехода — по тому же правилу, что и номер выше: и
                // кромка, и подложка держатся на `tone`, который переключает
                // клавиатура.
                'border-l-4 px-3 py-1',
                RULE[tone],
                /*
                 * Одна подложка из трёх, а не три класса стопкой: `cn` — это
                 * clsx, он ничего не разрешает, и два `bg-*` рядом решает
                 * порядок в собранном CSS, а не порядок здесь.
                 *
                 * Запертая холоднее обычной — подмешанный brand, а не другой
                 * уровень поверхности: она не «глубже» и не «выше» соседних,
                 * она просто не твоя. И только холоднее: гасить её целиком
                 * нельзя, за выводами на лекцию и приходят.
                 */
                selected && !shownRunning && !hasError
                  ? 'bg-raised'
                  : shut
                    ? isCode
                      ? 'bg-brand/[0.05]'
                      : 'bg-brand/[0.035]'
                    : isCode
                      ? 'bg-surface'
                      : 'bg-surface/70',
              )}
              onfocusout={(event) => {
                // Blurring a note puts it back to rendered form; code cells stay open.
                if (isCode) return
                const next = event.relatedTarget as Node | null
                if (!next || !event.currentTarget.contains(next)) commitMarkdown()
              }}
            >
              {@render openMark()}
              <!--
                Подсказки от ядра получает только этот редактор — тот, в
                котором пишут в общую тетрадь. Лист консилиума и черновик ниже
                по файлу про ядро комнаты ничего не спрашивают: там пишут СВОЙ
                текст, которого в ядре нет, а показывать по нему чужие
                переменные значило бы открывать состояние ядра тем, кому
                правило `run` его не открывает. Markdown-ячейка отсеивается уже
                в самом редакторе: там пишут прозой.
              -->
              <CodeEditor
                text={ytext}
                awareness={session.awareness}
                cellId={id}
                undoManager={session.undoManager}
                language={isCode ? 'python' : 'markdown'}
                label={tr('room.cell.label', { type: isCode ? tr('room.extra.139') : tr('room.extra.140'), count: ordinal })}
                readOnly={!mayEdit}
                autoFocus={!isCode && focusOnEdit}
                placeholder={isCode ? '' : tr('room.extra.141')}
                complete={(code, cursor) => session.complete(code, cursor, id)}
                inspect={(code, cursor) => session.inspect(code, cursor, id)}
                onfocus={() => onselect()}
                onrun={run}
                onrunstep={runAndStep}
                onrunandadd={runAndAdd}
                onescape={() => {
                  if (isCode) root?.querySelector<HTMLElement>('.cm-content')?.blur()
                  else commitMarkdown()
                }}
                ondeleteempty={deleteIfEmpty}
                onarrowout={(direction) => step(direction)}
              />
              <!--
                Одна строка под кодом — вместо погашенной ячейки.

                Редактор молча не берёт набор, и молчание читается как поломка:
                человек жмёт клавиши, ничего не появляется, и он идёт проверять
                клавиатуру. Слова стоят там, где он смотрит, — под самой
                ячейкой, а не в тосте у края экрана, — и говорят про занятие, а
                не про правило: открыть эту ячейку может преподаватель, и он
                рядом.
              -->
              {#if shut}
                <p class="flex items-center gap-2 pb-1 pt-1.5 text-2xs text-muted">
                  <span aria-hidden="true" class="h-px w-3.5 shrink-0 bg-line"></span>
                  {tr(LECTURE_CELL)}
                </p>
              {/if}
            </div>
          {:else}
            <!-- A note at rest carries no chrome at all: it is the seminar's
                 prose, and the editor is a thing you go and get. -->
            <!--
              Рельса есть и у прочитанного текста. Её тут не было вовсе: она
              рисовалась только внутри редактора, поэтому у текстовой ячейки при
              выборе менялся один номер в поле слева — по нему невозможно
              сказать, какая ячейка выбрана, если смотреть на текст, а не на
              поля. Теперь у всех ячеек одна и та же вертикальная полоса, и
              выбранная отличается от остальных так же, как работающая.
            -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class={cn(
                // См. выше: `tone` переключается стрелкой, переходу здесь не
                // место.
                'note border-l-4 px-3 py-1',
                RULE[tone],
                selected ? 'bg-surface/70' : 'bg-transparent',
              )}
              ondblclick={() => enter()}
            >
              {@render openMark()}
              {#if liveText.current.trim()}
                <Markdown source={liveText.current} class="text-prose text-muted" />
              {:else}
                <!-- Приглашение — только тому, кого пустят: двойной щелчок по
                     запертой заметке отвечает отказом, и звать к нему значит
                     обещать действие, которого в этой комнате нет. Тот же
                     довод, по которому у запертой ячейки убран первый слот
                     тулбара. -->
                <p class="text-prose text-muted">
                  {mayEdit ? tr('room.ui.366') : tr('room.ui.367')}
                </p>
              {/if}
            </div>
          {/if}

          <!--
            Пульт преподавателя — под эталоном.

            Полоса режима, стопка и сводка живут в CouncilStack (components/
            council): один вход на оба вида. Здесь — монтаж и провода к сокету:
            показать, запустить, ответить, отметить, спросить оракула, попросить
            вывод попытки, не поехавший со стопкой. Положение в стопке —
            состояние этого экрана, не комнаты, и живёт в этой ячейке;
            вид (стопка/сводка) — общий на все ячейки, в CouncilState.
          -->
          {#if pultOpen}
            <!--
              Пульт открыт в отдельном окне — под ячейкой остаётся ОДНА строка.

              Ровно те числа, что зал и так видит на проекторе, и ни одного
              имени: стопка, сводка и оракул на это время скрыты целиком. Два
              места с одним и тем же — источник утечки, ради которой окно и
              заводили (Paper · 05c · доска 11).
            -->
            <div
              class="flex flex-wrap items-center gap-2.5 border-l-4 border-brand bg-surface px-3 py-2"
              data-council-pult-open
            >
              <span class="text-ui font-bold text-ink">{tr('room.ui.1364')}</span>
              <span class="flex-1 text-2xs text-muted">
                · {countLine(count ?? { submitted: 0, total: 0 })}
                {#if (board?.counts.writing ?? 0) > 0}
                  · {tr('room.ui.1056', { count: board?.counts.writing ?? 0 })}
                {/if}
              </span>
              <button
                type="button"
                class={cn(CAPS, 'shrink-0 text-accent-text hover:underline')}
                onclick={raiseCouncilPult}
              >{tr('room.ui.1365')}</button>
            </div>
          {:else if leads && (inCouncil || (board?.counts.attempts ?? 0) > 0)}
            <!--
              И после закрытия консилиума, пока есть попытки: сданное остаётся
              на просмотр до конца занятия, а закрытие стопка объявляет сама.
            -->
            <div class="border-l-4 border-accent bg-accent/[0.04] px-3 py-2">
              {#if board}
                <CouncilStack
                  {board}
                  cellId={id}
                  cellIndex={index + 1}
                  position={stackPosition}
                  view={session.council.view}
                  askWhy={may.ask ? null : may.askWhy}
                  onshow={showToClass}
                  onrun={runAttemptOf}
                  requestsDisabled={controlDisabled(session.connected) || !inCouncil || !acts}
                  onapproverun={(participantId, requestId) => session.council.approveRunRequest(id, participantId, requestId)}
                  ondeclinerun={(participantId, requestId) => session.council.declineRunRequest(id, participantId, requestId)}
                  onreply={replyTo}
                  onmark={markAttempt}
                  onneedoutputs={(participantId) => session.council.wantOutputs(id, participantId)}
                  onask={() => void askOracle(false)}
                  onstop={() => void askOracle(true)}
                  onposition={(participantId) => (stackPosition = { participantId })}
                  ontoggle={(view) => (session.council.view = view)}
                />
              {:else}
                <p class={cn(CAPS, 'text-accent-text')}>{tr('room.ui.368')} {ordinal}</p>
                <p class="pt-1 text-2xs text-muted"> {tr('room.ui.369')} </p>
              {/if}
            </div>
          {/if}

          <!--
            Та же плашка — преподавателю, под стопкой.

            Он ведёт по ней разговор и должен видеть ровно то, что видит класс:
            ту же подпись (имя или «Вариант N» при выключенной ручке имён), тот
            же код, тот же свой вывод. Разница в одной ссылке справа — «убрать с
            экрана», и она есть только здесь.
          -->
          {#if leads && showsOnScreen && onScreen}
            <div transition:slide={{ duration: prefersReducedMotion() ? 0 : 200, easing: quintOut }}>
              <CouncilOnScreen
                shown={onScreen}
                mayClear
                onclear={() => session.council.clearShown(id)}
              />
            </div>
          {/if}

          <!--
            Консилиум закрыли, а лист остался.

            Замок ушёл в другое положение — тело ячейки снова общее, а то, что
            человек написал, никуда не пропало: оно здесь, черновиком, свёрнуто.
            Строка обязана это сказать — иначе пропавший из-под рук редактор
            читается как «вашу работу стёрли».
          -->
          {#if !inCouncil && !leads && sheet}
            <div class={cn('border-l-4 px-3 py-1.5', RULE[tone], 'bg-surface/70')}>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class={cn(CAPS, 'text-muted')}>{tr('room.ui.370')}</span>
                <span class="text-2xs text-muted">{tr(COUNCIL_CLOSED)}</span>
                <button
                  type="button"
                  class="ml-auto text-2xs text-accent-text hover:underline"
                  aria-expanded={showDraft}
                  onclick={() => (showDraft = !showDraft)}
                >
                  {showDraft ? tr('room.ui.371') : tr('room.ui.372')}
                </button>
              </div>
              {#if showDraft}
                <div class="pt-1 opacity-70">
                  <CodeEditor
                    text={sheet.text}
                    awareness={sheet.awareness}
                    undoManager={sheet.undo}
                    language={isCode ? 'python' : 'markdown'}
                    label={tr('room.extra.143', { p0: ordinal })}
                    readOnly={true}
                  />
                </div>
              {/if}
            </div>
          {/if}

          <!--
            Asking the oracle to change this cell, and what it answered.

            Both live under the cell rather than in the side panel, because both are about
            this cell: the sentence you type is about it, and the diff that comes back
            replaces it. The panel still receives every word — the question, the reasoning
            and the code — because the room is entitled to know why the notebook it is
            reading changed.
          -->
          {#if asking && mayRewrite}
            <div class={cn('flex flex-col gap-2 border-l-4 px-3 py-2.5', RULE[tone], 'bg-surface')}>
              <textarea
                bind:this={promptBox}
                bind:value={prompt}
                rows="2"
                class="w-full resize-none border border-line bg-canvas px-3 py-2 text-ui text-ink
                       placeholder:text-faint focus:border-accent focus:outline-none"
                placeholder={tr('room.ui.373')}
                onkeydown={(event) => {
                  // Enter sends: this is one sentence, not a document. Shift+Enter is
                  // there for the person who wants two.
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void sendEdit()
                  }
                  if (event.key === 'Escape') asking = false
                }}
              ></textarea>
              <div class="flex flex-wrap items-center gap-2.5">
                <button type="button" class="btn-primary h-8" disabled={sending || !prompt.trim()} onclick={sendEdit}>
                  {#if sending}
                    <Icon name="spinner" size={13} class="animate-spin" /> {tr('room.ui.374')} {:else} {tr('room.ui.375')} {/if}
                </button>
                <button type="button" class="btn-ghost h-8" onclick={() => (asking = false)}>{tr('room.ui.376')}</button>
                {#if askError}
                  <span class="text-2xs text-danger" role="alert">{askError}</span>
                {:else}
                  <span class="text-2xs text-muted">{tr('room.ui.377')}</span>
                {/if}
              </div>
            </div>
          {/if}

          {#if proposal}
            <!--
              Та же пара, что у формы ввода: сплошной акцент здесь перекрывал
              и RULE.running на работающей ячейке, и RULE.error на упавшей, ради
              исправления которой предложение и просили.
            -->
            <div class={cn('border-l-4 bg-accent/[0.04]', shownRunning ? 'border-accent/40' : 'border-accent')}>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2">
                <span class={cn(CAPS, 'text-accent-text')}>{tr('room.ui.378')}</span>
                <span class="font-mono text-2xs">
                  {#if proposedCounts.added > 0}<span class="text-positive">+{proposedCounts.added}</span>{/if}
                  {#if proposedCounts.removed > 0}<span class="ml-1.5 text-danger">−{proposedCounts.removed}</span>{/if}
                </span>
                {#if proposalStale}
                  <!-- Not a refusal: the room may want the rewrite anyway. But accepting
                       deletes whatever arrived in the meantime, and that has to be said
                       before the press rather than after. -->
                  <span class="text-2xs text-warning"> {tr('room.ui.379')} </span>
                {/if}
              </div>
              <div class="overflow-x-auto whitespace-pre px-3 py-2 font-mono text-code-lg leading-[21px]"><div class="w-max min-w-full">{#each proposedLines as line, index (index)}<span class={cn('block min-h-[21px]', line.kind === 'added' && 'bg-positive/10', line.kind === 'removed' && 'bg-danger/10', line.kind === 'same' && 'opacity-55')}><span class="inline-block w-5 select-none text-center text-faint">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '\u2212' : ' '}</span><CodeLine tokens={proposedTokens[index] ?? []} /></span>{/each}</div></div>
              <div class="flex flex-wrap items-center gap-2.5 border-t border-line-soft px-3 py-2">
                <!-- Когда почва ушла, залитая кнопка меняет владельца: рефлекс
                     после пяти принятий — нажать заполненную, и он обязан
                     попадать в безопасный исход. Так же в панели оракула. -->
                <!-- «Принять» — правка общей тетради, и спрашивает она у ЯЧЕЙКИ:
                     в лекции и в общей ячейке консилиума правит преподаватель.
                     Кнопка гаснет и называет причину; «Отклонить» остаётся
                     всем — снятая плашка ничего не рушит, пока идёт занятие. -->
                {#if proposalStale}
                  <button type="button" class="btn-primary h-8" onclick={decline}>{tr('room.ui.380')}</button>
                  <button
                    type="button"
                    class="btn-outline h-8"
                    disabled={!mayPatchHere}
                    title={mayPatchHere ? '' : patchWhy}
                    onclick={accept}
                  >{tr('room.ui.381')}</button>
                {:else}
                  <button
                    type="button"
                    class="btn-primary h-8"
                    disabled={!mayPatchHere}
                    title={mayPatchHere ? '' : patchWhy}
                    onclick={accept}
                  >{tr('room.ui.382')}</button>
                  <button type="button" class="btn-outline h-8" onclick={decline}>{tr('room.ui.380')}</button>
                  <span class="text-2xs text-muted">{mayPatchHere ? tr('room.ui.383') : patchWhy}</span>
                {/if}
              </div>
            </div>
          {/if}

          <!--
            Область вывода не сжимается, пока в неё нечего положить.

            Вывод стирается в момент старта — прошлое число, выглядящее свежим,
            на проекторе хуже любого рывка, — но высота остаётся. Перезапуск
            ячейки, печатающей то же самое, не двигает страницу вовсе; ячейка,
            у которой вывод правда изменился в размере, двигается один раз и на
            настоящую разницу. Сейчас каждая двигается дважды.

            Это пол, а не обещание: у блока нет ни верхней, ни нижней, ни правой
            границы и нет скругления, так что пустым он неотличим от отступа.
            Не предмет, стоящий пустым, а ячейка, которая ещё не сжалась. Что
            происходит, объясняют дышащая полоса слева и строка Running под ней
            — добавлять сюда третью подпись значило бы сказать одно и то же
            трижды.

            Читается настоящее `running`, а не `shownRunning`: это раскладка, а
            не сигнал занятости. Порог в двести миллисекунд к ней не относится
            — привязать место к нему значило бы схлопывать быстрые ячейки и
            держать медленные, то есть вывернуть оба механизма наизнанку.
          -->
          <!--
            `!ownSheet`: у студента в открытом консилиуме общей ячейки на
            экране нет — ни кода, ни вывода. Вывод остался бы последним её
            следом: чужой запуск (или «Показать классу») печатал бы числа прямо
            под СВОИМ листом человека, и прочитать их как не свои нечем. Свой
            вывод у попытки есть, и лежит он там же — сразу под листом.
          -->
          {#if isCode && !ownSheet && (outputs.current.length > 0 || outputFloor > 0)}
            <!--
              Пустое место не рисует ничего — ни фона, ни кромки.

              Первая версия оставляла блоку и `bg-surface/50`, и цветную кромку,
              и утверждала в комментарии, что пустым он «неотличим от отступа».
              Это была неправда: получался серый прямоугольник с полосой, ростом
              с прошлый вывод. На трейсбеке — в полэкрана. Не неподвижность, а
              дыра, и именно так о ней и сообщили.

              Смысл резерва в том, что страница не двигается, а не в том, что на
              ней что-то стоит. Поэтому пока класть нечего, блок — чистая
              высота.
            -->
            {@const seatOnly = outputs.current.length === 0}
            <!--
              Вывод лежит на ЛИСТЕ, код — на плите: разные подложки плюс
              волосяная линия по границе.

              Раньше обе половины ячейки стояли на surface — код сплошным, вывод
              тем же цветом в половину силы, — и на белой теме различить их было
              нечем: 243→249 при фоне страницы 255. Ночью пара читалась, и
              именно поэтому беда жила так долго: смотрели в тёмной.

              Направление выбрано не из вкуса, а по тому, что уже напечатано:
              опубликованная страница (server/src/publish/render.ts) и читальня
              рисуют ровно это — код на подложке, вывод на фоне карточки, между
              ними линия в `line`. Комната была единственным местом, где тетрадь
              выглядела иначе. Заодно счёт сходится в обе стороны: на свету лист
              светлее плиты, ночью — темнее её, и «это напечатал компьютер»
              читается одинаково.

              Полоса состояния идёт сквозь обе половины и цвета не меняет: она
              про ЯЧЕЙКУ — работает, упала, открыта, выбрана, — а не про то,
              где кончается код. Разорвать её значило бы завести второй язык
              там, где уже есть первый.

              Цвет самой линии — стилем, а не классом: `RULE[tone]` красит
              border-color целиком, и `border-t-line` рядом с ним решался бы
              порядком утилит в собранном CSS, а не тем, что написано здесь. А
              линия обязана остаться серой и у работающей, и у упавшей: она не
              сигнал, она граница.
            -->
            <div
              class={cn(
                'transition-[background-color] duration-[var(--speed-quick)]',
                !seatOnly && 'border-l-4 border-t',
                !seatOnly && RULE[tone],
                !seatOnly && (hasError ? 'bg-danger/5' : 'bg-canvas'),
              )}
              style:border-top-color={seatOnly ? undefined : 'rgb(var(--line))'}
              style:min-height={outputFloor > 0 ? `${outputFloor}px` : undefined}
            >
              <!--
                Мерит один узел, держит другой — и это обязательно.

                Повесь `min-height` и `bind:clientHeight` на один элемент, и
                резерв начнёт читать сам себя: запомненная высота дорастёт до
                самой большой, какая когда-либо была, и обратно уже не
                опустится. В быстром тесте это выглядит совершенно правильно.
              -->
              <div bind:clientHeight={outputsMeasured}>
                {#if outputs.current.length > 0}
                  <div class="px-2 py-1.5">
                    <CellOutputs outputs={outputs.current} bind:pending={outputsPending} />
                  </div>
                  <!--
                    Строка под выводом — только там, где ей есть что СКАЗАТЬ.
                    
                    Стояли здесь черта во всю ширину и «Out [2] · 1.4 s» в
                    дальнем углу: линия делила экран пополам ради одного числа,
                    а само число читалось раз в час и не рисовалось вовсе у
                    ячеек без вывода. Число уехало в поле, к номеру ячейки
                    (см. `mark`), черта ушла совсем — вывод кончается там, где
                    кончается вывод. Остались слова: кто запускал и что номер
                    потерян, — их в поле не уместить, а сказать надо.
                  -->
                  {#if ranByOther || unnumbered}
                    <div class="flex items-center gap-3 px-4 pb-1.5 pt-0.5">
                      {#if unnumbered}
                        <!--
                          Словами, а не оттенком: язык переживает и проектор, и
                          скриншот в чате, и дальтонизм. Это состояние, а не
                          промелькнувший переход, — оно висит ровно столько,
                          сколько остаётся правдой.
                        -->
                        <span class="text-2xs text-warning"> {tr('room.ui.384')} </span>
                      {/if}
                      {#if ranByOther}
                        <span class="font-mono text-2xs text-muted">{ranByOther}</span>
                      {/if}
                    </div>
                  {/if}
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class={cn('border-l-4 bg-surface/50', RULE[tone])} style="height: {parkHeight}px"></div>
      {/if}

      {#if stdin}
        <!--
          Форма стоит под ячейкой, а не в тосте: ждёт именно эта ячейка, и
          смотреть надо на неё. Кромка цветом бегущей — потому что ячейка и
          правда бежит, просто остановилась о человека.
        -->
        <form
          class={cn(
            'mt-1.5 flex items-center gap-2 border-l-4 bg-accent/[0.07] px-3 py-2',
            // В пару к RULE.running: на работающей ячейке кромка приглушена, и
            // сплошной акцент здесь читался бы как третий оттенок в столбце.
            shownRunning ? 'border-accent/40' : 'border-accent',
          )}
          onsubmit={sendAnswer}
        >
          <span class={cn(CAPS, 'shrink-0 text-accent-text')}>{tr('room.ui.385')}</span>
          {#if stdin.prompt}
            <span class="shrink-0 font-mono text-code text-ink">{stdin.prompt}</span>
          {/if}
          <!--
            Поле — только тому, чей ответ примут. Остальным остаётся сама
            плашка: что ячейка встала и чего она ждёт, комната видеть должна.
          -->
          {#if canAnswer}
            <input
              bind:this={answerField}
              bind:value={answer}
              type={stdin.password ? 'password' : 'text'}
              class="field h-8 min-w-0 flex-1 font-mono text-code-lg"
              autocomplete="off"
              spellcheck="false"
              aria-label={stdin.prompt || tr('room.cell.waitingInput')}
            />
            <!-- Нажатие — здесь же: ответ уходит в ядро, и до него на экране
                 не меняется ничего. Свойства перечислены, а не `.press`:
                 утилита `transition-*` переписала бы transition-property и
                 оставила transform за списком (см. CAP в Notebook.svelte). -->
            <button
              type="submit"
              class={cn(
                'inline-flex h-8 shrink-0 items-center bg-primary px-3 text-primary-ink',
                CAPS,
                'transition-[opacity,transform] duration-press ease-out',
                'enabled:active:scale-[0.97] hover:opacity-90',
              )}
            > {tr('room.ui.386')} </button>
          {/if}
        </form>
      {/if}

      <!--
        Единственное, что движется в тетради.
        
        Ширина в 4px — это ровно `border-l-4`, и стоит она на том же месте: не
        вторая линия рядом, а та же самая, зажжённая. Под ней приглушённый
        `RULE.running`, поверх — акцент, дышащий с 1 до 0.25; вместе выходит
        кромка, ходящая между полным акцентом и 55 %.
        
        Дыхание остаётся и при prefers-reduced-motion, и это записано в
        политике в index.css: непрерывные указатели не гасят, потому что
        остановившийся указатель — это ложь о системе. Полоса никуда не едет,
        меняет одно композитное свойство, не доходит до нуля и делает меньше
        одного удара в секунду — то есть ничего из того, ради чего движение
        убирают.
      -->
      {#if shownRunning}
        <span
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 left-0 w-1 animate-blink bg-accent"
        ></span>
      {/if}
      </div>

      <!--
        Подпись под формой ввода стоит ВНЕ обёртки с полосой.

        Полоса растянута на всю обёртку (`inset-y-0`), а у этой подписи кромки
        `border-l-4` нет — как нет её и у отступа `mt-1.5` над самой формой.
        Пока подпись лежала внутри, светящаяся линия уходила на пару десятков
        пикселей ниже кромки, которую она подсвечивает, и повисала в воздухе.
      -->
      {#if stdin}
        <p class="px-3 pt-1 text-2xs text-muted">
          {#if canAnswer} {tr('room.ui.387')} {:else if !acts}
            <!-- Две разные причины, и звонок из них старше: звать к полю того,
                 кто эту ячейку и запустил, после конца занятия — значит звать
                 человека к отказу. Имени здесь поэтому нет. --> {tr('room.ui.388')} {:else} {tr('room.ui.389')} {runBy ?? tr('room.ui.390')} {tr('room.ui.391')} {/if}
        </p>
      {/if}

      {#if shownRunning}
        <!--
          Строка состояния этой ячейки для всей комнаты.

          Остаётся, хотя «стоп» теперь есть и в тулбаре, — и вот почему.
          Тулбар открывается по наведению, а работающая ячейка сплошь и рядом
          не та, под которой курсор: Run All считает седьмую, пока правят
          двенадцатую. Сделать единственную кнопку остановки той, до которой
          надо ещё доехать мышью, — худший из возможных разменов ровно в тот
          момент, когда кто-то хочет убить бесконечный цикл; на планшете
          наведения нет вовсе. К тому же строка рисуется вне `{#if mounted}` и
          говорит про ячейку, чей редактор припаркован, и несёт то, чего в
          значок 24×24 не положишь: кто запустил, его лицо и сколько идёт.

          Секундомер здесь. Раньше на этом месте стояло «времени выполнения нет
          в документе, поэтому мы его и не заявляем» — теперь есть: одна
          отметка, записанная ядром в той же транзакции, что начинает
          выполнение. Считает её этот компонент, потому что то, что ещё идёт,
          считают там, где смотрят.
        -->
        <div class={FOOTER}>
          {#if runner}
            <Avatar
              name={runner.name}
              color={runner.color}
              avatar={runner.avatar}
              size="xs"
              title={tr('room.extra.150', { p0: runner.name })}
            />
          {/if}
          <!--
            «Ждёт», когда ячейка остановилась о человека: она правда
            выполняется, но сказать «Running» прямо над формой, которая
            говорит «ядро ждёт ответа», значит дать листу поспорить с собой.
            Полоса при этом дышит, а секундомер считает: прошедшее время
            выполнения — всё ещё прошедшее время выполнения.
          -->
          <!--
            Крутящийся значок у самого слова.

            Полоса слева говорит комнате, КАКАЯ ячейка занята, и читается через
            весь зал; этот значок говорит одному человеку, что система жива, и
            читается с расстояния вытянутой руки. Разные вопросы и разные
            дистанции, поэтому их двое. Значок приглушённый: спорить с
            акцентным словом рядом он не должен.

            У ожидания ввода не крутится — там ничего не происходит, пока
            кто-нибудь не ответит, и вертящийся значок обещал бы работу.
          -->
          {#if !stdin}
            <Icon name="spinner" size={12} class="shrink-0 animate-spin text-accent-text/70" />
          {/if}
          <span class={cn(CAPS, 'text-accent-text')}>{stdin ? tr('room.ui.392') : tr('room.ui.393')}</span>
          {#if runBy}
            <span class="text-2xs text-muted">{tr('room.ui.394')} {runBy}</span>
          {/if}
          <!--
            Секундомер и «стоп» — одна группа, прижатая вправо: группа растёт
            влево, поэтому правый край кнопки не двигается, когда появляются
            цифры. `tabular-nums` и `shrink-0`, иначе ряд дёргается пять раз в
            секунду.
          -->
          <div class="ml-auto flex items-center gap-2">
          {#if meta.current.startedAt !== null}
            <span class="shrink-0 font-mono text-2xs tabular-nums text-muted">
              {elapsed(meta.current.startedAt, now - session.clockSkewMs)}
            </span>
          {/if}
          <button
            type="button"
            disabled={controlDisabled(session.connected, canInterrupt)}
            title={controlTitle(
              session.connected,
              canInterrupt ? tr('room.extra.151') : tr('room.extra.152'),
            )}
            onclick={() => session.send({ t: 'interrupt', cellId: id })}
            class={cn(
              'inline-flex h-6 items-center border border-line px-2 text-ink',
              CAPS,
              // Кнопка паники: сервер отвечает не мгновенно, и нажатие — это
              // единственное, что подтверждает, что его услышали. Тот же
              // рецепт, что у «Cancel» ниже и у всей полосы Run.
              'transition-[color,background-color,border-color,transform] duration-press ease-out',
              'enabled:active:scale-[0.97] hover:bg-raised',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          > {tr('room.ui.395')} </button>
          </div>
        </div>
      <!--
        A queued cell said nothing at all whenever the document's queue had not
        caught up with the cell's own state — which is exactly the moment after
        somebody presses Run All, and exactly when the room wants to know that
        their cell is waiting rather than ignored. The position is extra when we
        have it; that it is queued, and whose it is, we always have.
      -->
      {:else if shownState === 'queued'}
        <div class={FOOTER}>
          <!-- The chip is the POSITION. Without one it would only say "queued"
               beside "queued by John", which is the same word twice. -->
          {#if queuePosition >= 0}
            <span
              title={tr('room.ui.396')}
              class="inline-flex h-5 items-center bg-raised px-2 font-mono text-2xs text-muted"
            >
              {place(queuePosition + 1)} {tr('room.ui.397')} </span>
          {/if}
          <span class={cn(CAPS, 'text-accent-text')}>{tr('room.ui.398')}</span>
          {#if runBy}
            <span class="text-2xs text-muted">{tr('room.ui.399')} {runBy}</span>
          {/if}
          {#if canCancel}
            <button
              type="button"
              disabled={controlDisabled(session.connected)}
              title={controlTitle(session.connected, tr('room.extra.154'))}
              onclick={() => session.send({ t: 'cancel', cellId: id })}
              class={cn(
                'ml-auto inline-flex h-6 items-center border border-line px-2 text-ink',
                CAPS,
                // Spelled out, not `.press`: a Tailwind transition-* utility rewrites
                // transition-property, so the helper's transform would be left out of
                // the list and the scale would snap. Same shape the run bar's CAP uses.
                'transition-[color,background-color,border-color,transform] duration-press ease-out',
                'enabled:active:scale-[0.97] hover:bg-raised',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                'disabled:pointer-events-none disabled:opacity-40',
              )}
            > {tr('room.ui.376')} </button>
          {/if}
        </div>
      {:else if hasError && aiReady && may.ask}
        <div class={FOOTER}>
          <button
            type="button"
            onclick={() => askAi('fix')}
            class={cn(
              // The filled pair, like Run all: cyan cannot carry a fill in light.
              'inline-flex h-7 items-center gap-2 bg-primary px-3 text-primary-ink',
              CAPS,
              'transition-[opacity,transform] duration-press ease-out',
              'enabled:active:scale-[0.97] hover:opacity-90',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
              'focus-visible:ring-primary-ink/60',
            )}
          >
            <Icon name="sparkles" size={12} /> {tr('room.ui.400')} </button>
          <span class="text-2xs text-muted">{tr('room.ui.401')}</span>
        </div>
      {/if}

      {#if editingHere}
        <div class="{FOOTER} enter">
          {#each peersHere.current.slice(0, 4) as peer (peer.clientId)}
            <Avatar
              name={peer.user.name}
              color={peer.user.color}
              avatar={peer.user.avatar}
              size="xs"
              title={tr('room.extra.158', { p0: peer.user.name })}
            />
          {/each}
          <span class="text-2xs text-muted">{editingHere}</span>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /*
   * A note in the notebook is the seminar's prose: the artboard leads it with a
   * display heading in the black weight and drops the body to muted, so the
   * code below it stays the loudest thing on the sheet. .prose-note in
   * index.css is shared with the oracle panel, which wants neither, so the
   * notebook's own voice is set here rather than by retuning every reader.
   */
  .note :global(.prose-note h1) {
    @apply text-display font-black text-ink;
  }
  .note :global(.prose-note h2) {
    @apply text-head font-black text-ink;
  }
</style>
