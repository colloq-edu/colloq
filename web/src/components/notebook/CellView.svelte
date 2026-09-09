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
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon, { type IconName } from '@/components/ui/Icon.svelte'
  import Code from '@/components/ui/Code.svelte'
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
  import { cn, elapsed, NOTICED_MS, spell } from '@/lib/utils'
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

  const editingHere = $derived.by(() => {
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

  /** Строка вопроса живая ровно тогда, когда её примут. */
  const mayRewrite = $derived(may.ask && rewriteReady)
  const rewriteRefusal = $derived(!may.ask ? may.askWhy : (rewriteWhy ?? tr('room.ui.427')))

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
    if (node) {
      node.focus()
      return
    }
    // The cell was inserted or unparked a moment ago and CodeMirror has not
    // been built yet.
    requestAnimationFrame(() => find()?.focus())
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
    step(1, true, false, true)
  }

  /** Only Notebook knows the cell order, so hand-offs go through it. */
  function step(direction: -1 | 1, focus = true, fallback = false, grow = false) {
    window.dispatchEvent(
      new CustomEvent('colloq:step-cell', { detail: { cellId: id, direction, focus, fallback, grow } }),
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
    if (!mayEdit) {
      session.showError(editWhy + '.')
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
      if (detail.step) step(1, false, false, true)
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
                  «Имена на проекторе» отсюда убраны, и это не потеря.

                  Ручка писалась в документ и сравнивалась на сервере — и на
                  этом всё: ни проекторная полоса (SessionScreen), ни `council:
                  show`, ни счётчик имён не показывают, а проектор в своём же
                  комментарии объясняет, почему их там нет. Переключатель,
                  который в обе стороны не меняет ничего, — обещание без
                  исполнения; поле в `CouncilSettings` остаётся ради старых
                  документов и вернётся сюда вместе с исполнением.
                -->
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
      onpointerdown={(event) => onselect(event)}
    >
      <!-- Out of flow and above the body: a toolbar that appeared in flow would
           push the cell down the moment the pointer arrived. -->
      <div
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
        <button
          type="button"
          class={TOOL}
          title={may.add ? tr('room.extra.123') : may.structureWhy}
          aria-label={tr('room.ui.343')}
          disabled={!may.add}
          onclick={() => duplicateCell(session.doc, bookRoot, id)}
        >
          <Icon name="duplicate" size={13} />
        </button>
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
              Свой лист студента в консилиуме — вместо общего редактора.

              Тот же CodeMirror, но привязан к локальному документу (см.
              `openSheet`): в общий Y.Text отсюда не уходит ни буквы. Снимок
              уезжает сам при паузе в наборе и на уходе фокуса; «Сдать» — кнопка
              и Shift+Enter, потому что запуска у студента здесь нет и пальцы,
              привыкшие к «выполнить и дальше», должны попадать в «сдать», а не
              в отказ.
            -->
            <!--
              Общая ячейка — над своим листом, только чтение.

              Третье правило консилиума: класс видит то, что показал
              преподаватель. «Показать классу» кладёт текст попытки в общий
              Y.Text ячейки — а тело ячейки у студента в это время занято его
              листом, и общий текст не рисовался нигде: показанное видел один
              преподаватель, автору приходил чип «На экране», а соседи не
              видели ничего. Проектор на лекции показывает страницы, не
              тетрадь. Поэтому общий текст стоит здесь, и вместе с ним —
              задание, пока преподаватель ничего не показал. Пустой — не
              рисуется: пустая рамка над листом ничего не говорит.
            -->
            {#if liveText.current.trim()}
              <div class={cn('border-l-4 px-3 py-1', RULE[tone], 'bg-brand/[0.035]')}>
                <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 pb-1 pt-0.5">
                  <span class={cn(CAPS, 'text-muted')}>{tr('room.ui.347')}</span>
                  <span class="text-2xs text-muted"> {tr('room.ui.348')} </span>
                </div>
                {#if isCode}
                  <Code code={liveText.current} />
                {:else}
                  <Markdown source={liveText.current} class="text-prose text-muted" />
                {/if}
              </div>
            {/if}
            <div
              class={cn('border-l-4 px-3 py-1', RULE[tone], 'bg-surface')}
              onfocusout={(event) => {
                const next = event.relatedTarget as Node | null
                if (!next || !event.currentTarget.contains(next)) session.council.flush(id)
              }}
            >
              <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 pb-1 pt-0.5">
                <span class={cn(CAPS, mine?.shown ? 'text-positive' : 'text-accent-text')}>
                  {mine?.shown ? tr('room.ui.349') : tr('room.ui.34')}
                </span>
                <span class="text-2xs text-muted">
                  {#if mine?.shown} {tr('room.ui.350')} {:else if councilClosed}
                    {tr(COUNCIL_CLOSED)}
                  {:else if submittedAt !== null && !attemptSynced}
                    <!-- «Сдано» — про текст, а не про нажатие: у преподавателя
                         лежит прошлый снимок, и назвать сданным этот значило бы
                         соврать в том, ради чего консилиум и затевали. -->
                    <span class="text-warning"> {tr('room.ui.351')} </span>
                  {:else if submittedAt !== null} {tr('room.ui.50')} {clock(submittedAt)} {tr('room.ui.352')} {:else} {tr('room.ui.353')} {/if}
                </span>
                {#if count}
                  <span class="ml-auto font-mono text-2xs tabular-nums text-muted">
                    {countLine(count)}
                  </span>
                {/if}
              </div>
              <!-- Сданное приглушено: текст на месте, но это уже не черновик, а
                   лист, который смотрят. «Изменить» возвращает всё как было. -->
              <div class={cn(submittedAt !== null && 'opacity-60')}>
                <CodeEditor
                  text={sheet.text}
                  awareness={sheet.awareness}
                  undoManager={sheet.undo}
                  language={isCode ? 'python' : 'markdown'}
                  label={tr('room.extra.132', { p0: ordinal })}
                  readOnly={!mayAttempt || submittedAt !== null}
                  placeholder={tr('room.ui.354')}
                  onfocus={() => onselect()}
                  onrun={runAttempt}
                  onrunstep={() => void submitAttempt()}
                  onrunandadd={() => void submitAttempt()}
                  onescape={() => root?.querySelector<HTMLElement>('.cm-content')?.blur()}
                  onarrowout={(direction) => step(direction)}
                  maxChars={MAX_ATTEMPT_CHARS}
                  onoverflow={(chars) =>
                    session.showError(
                      tr('room.extra.133', { p0: MAX_ATTEMPT_CHARS.toLocaleString(getLocale()), p1: chars.toLocaleString(getLocale()) }),
                    )}
                />
              </div>
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
              <!-- Ответ преподавателя — строкой под попыткой, видна двоим.
                   Подпись — того, кто отвечал: в комнате может быть два
                   преподавателя, а черновик оракула сюда приходит уже его
                   словами.

                   Письмо на строку, а не все в одном абзаце: личный ответ и
                   рассылка группе написаны в разное время и разным людям, и
                   слитно они читаются одним письмом. Групповое помечено
                   словом — тогда молчание на личном значит «это вам». -->
              {#each letters as letter}
                <p class="flex flex-wrap items-baseline gap-x-2 border-t border-line-soft pb-1 pt-1.5 text-ui">
                  <span class="font-bold text-ink">{letter.by}</span>
                  <span class="font-mono text-2xs text-muted">{clock(letter.at)}</span>
                  {#if letter.to === 'group'}
                    <span class="text-2xs text-muted">{tr('room.ui.70')}</span>
                  {/if}
                  <span class="text-ink">{letter.text}</span>
                </p>
              {/each}
              <div class="flex flex-wrap items-center gap-2.5 pb-1 pt-1.5">
                {#if submittedAt === null}
                  <button
                    type="button"
                    class="btn-primary h-7"
                    disabled={!mayAttempt || controlDisabled(session.connected) || awaitingMine !== null}
                    title={controlTitle(session.connected, mayAttempt ? tr('room.extra.135') : attemptWhy)}
                    onclick={() => void submitAttempt()}
                  >
                    {awaitingMine === 'submit' ? tr('room.ui.66') : tr('room.ui.356')}
                  </button>
                  {#if mayAttempt}
                    <span class="text-2xs text-muted">{tr('room.ui.357')}</span>
                  {:else}
                    <span class="text-2xs text-muted">{attemptWhy}</span>
                  {/if}
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
                    {awaitingMine === 'withdraw' ? tr('room.ui.66') : tr('room.ui.358')}
                  </button>
                  {#if !mayAttempt}
                    <span class="text-2xs text-muted">{attemptWhy}</span>
                  {/if}
                {/if}
                {#if councilSettings.studentRun === 'request' && !councilClosed}
                  {#if mine?.runRequest?.status === 'pending' && attemptSynced}
                    <span class="text-2xs text-accent-text" role="status">{tr('room.ui.359')}</span>
                    <button
                      type="button"
                      class="btn-ghost h-7"
                      disabled={!mayRequestRun || controlDisabled(session.connected) || requestSending !== null}
                      onclick={cancelAttemptRunRequest}
                    >{requestSending?.action === 'cancel' ? tr('room.ui.360') : tr('room.ui.361')}</button>
                  {:else}
                    <button
                      type="button"
                      class="btn-outline h-7"
                      disabled={!mayRequestRun || attemptRunning || attemptOver || !sheetText.trim() || controlDisabled(session.connected) || requestSending !== null}
                      title={controlTitle(session.connected, mayRequestRun ? tr('room.extra.137') : attemptWhy)}
                      onclick={requestAttemptRun}
                    >{requestSending?.action === 'request' ? tr('room.ui.362') : tr('room.ui.363')}</button>
                    {#if mine?.runRequest?.status === 'declined' && attemptSynced}
                      <span class="text-2xs text-muted" role="status">{tr('room.ui.364')}</span>
                    {:else if mine?.runRequest && !attemptSynced}
                      <span class="text-2xs text-muted" role="status">{tr('room.ui.365')}</span>
                    {/if}
                  {/if}
                {:else if mayRunAttempt && !councilClosed}
                  <button
                    type="button"
                    class="btn-ghost h-7"
                    disabled={controlDisabled(session.connected) || attemptRunning || attemptOver}
                    title={controlTitle(
                      session.connected,
                      tr('room.extra.138', { p0: tr(COUNCIL_SHARED_KERNEL_NOTE) }),
                    )}
                    onclick={runAttempt}
                  >{tr('room.ui.73')}</button>
                {/if}
                {#if mine?.queue != null}
                  <span class="inline-flex h-5 items-center bg-raised px-2 font-mono text-2xs text-muted" role="status">
                    {queueWords(mine.queue)}
                  </span>
                {/if}
              </div>
            </div>
            <!-- Вывод запуска — к попытке, не к общей ячейке: приезжает автору
                 вместе с попыткой и лежит под ней. -->
            {#if mine?.run}
              <div class={cn('border-l-4', RULE[tone], mine.run.state === 'error' ? 'bg-danger/5' : 'bg-surface/50')}>
                {#if mine.run.outputs.length > 0}
                  <div class="px-2 py-1.5">
                    <CellOutputs outputs={mine.run.outputs} />
                  </div>
                {/if}
                <div class="px-4 pb-1.5 pt-0.5 text-2xs text-muted">
                  {ranByLine(mine.run, spell)}
                </div>
              </div>
            {/if}
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
          {#if leads && (inCouncil || (board?.counts.attempts ?? 0) > 0)}
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
                {#if proposalStale}
                  <button type="button" class="btn-primary h-8" onclick={decline}>{tr('room.ui.380')}</button>
                  <button type="button" class="btn-outline h-8" onclick={accept}>{tr('room.ui.381')}</button>
                {:else}
                  <button type="button" class="btn-primary h-8" onclick={accept}>{tr('room.ui.382')}</button>
                  <button type="button" class="btn-outline h-8" onclick={decline}>{tr('room.ui.380')}</button>
                  <span class="text-2xs text-muted">{tr('room.ui.383')}</span>
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
          {#if isCode && (outputs.current.length > 0 || outputFloor > 0)}
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
            <div
              class={cn(
                'transition-[background-color] duration-[var(--speed-quick)]',
                !seatOnly && 'border-l-4',
                !seatOnly && RULE[tone],
                !seatOnly && (hasError ? 'bg-danger/5' : 'bg-surface/50'),
              )}
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
